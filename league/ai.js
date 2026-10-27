// Shared battle knowledge + 14 strategy bots for the Showdown engine.
// Bots see their own side fully; for the foe they see only public info
// (species, types, HP, boosts, status, revealed moves).
const {Dex} = require('pokemon-showdown');

const HAZARDS = new Set(['stealthrock', 'spikes', 'toxicspikes', 'stickyweb']);
const REMOVAL = new Set(['rapidspin', 'defog', 'mortalspin', 'tidyup', 'courtchange']);
const ABILITY_IMMUNE = {
	levitate: 'Ground', eartheater: 'Ground', flashfire: 'Fire', wellbakedbody: 'Fire',
	waterabsorb: 'Water', stormdrain: 'Water', dryskin: 'Water', voltabsorb: 'Electric',
	lightningrod: 'Electric', motordrive: 'Electric', sapsipper: 'Grass',
};
const boostMult = b => b >= 0 ? (2 + b) / 2 : 2 / (2 - b);

function stat(p, s) {
	let v = p.storedStats[s] * boostMult(p.boosts[s] || 0);
	if (s === 'spe' && p.status === 'par') v *= 0.5;
	if (s === 'spe' && p.item === 'choicescarf') v *= 1.5;
	return v;
}
const hpFrac = p => p.hp / p.maxhp;

// Expected damage as a fraction of the defender's max HP.
function estDamage(att, def, moveId, opts = {}) {
	const move = Dex.moves.get(moveId);
	if (!move.exists || move.category === 'Status') return 0;
	const atkTypes = opts.tera ? [att.teraType] : att.getTypes();
	const origTypes = att.species.types;
	const defTypes = def.getTypes();
	let type = move.type;
	if (move.id === 'terablast' && (opts.tera || att.terastallized)) type = att.teraType;
	if (!Dex.getImmunity(type, defTypes)) return 0;
	if (ABILITY_IMMUNE[def.ability] === type) return 0;
	if (move.ohko) return 0;
	if (move.damage === 'level') return Math.min(1, att.level / def.maxhp);
	if (typeof move.damage === 'number') return Math.min(1, move.damage / def.maxhp);
	if (move.id === 'superfang' || move.id === 'ruination') return def.hp / def.maxhp / 2;
	let bp = move.basePower;
	if (!bp) return 0;
	if (move.multihit) bp *= Array.isArray(move.multihit) ? (att.ability === 'skilllink' ? 5 : 3.1) : move.multihit;
	if (att.ability === 'technician' && move.basePower <= 60) bp *= 1.5;
	const phys = move.category === 'Physical';
	let a = stat(att, phys ? 'atk' : 'spa');
	let d = stat(def, phys ? 'def' : 'spd');
	if (move.id === 'bodypress') a = stat(att, 'def');
	if (move.id === 'foulplay') a = stat(def, 'atk');
	if (move.overrideDefensiveStat === 'def' || move.id === 'psyshock') d = stat(def, 'def');
	let dmg = ((2 * att.level / 5 + 2) * bp * a / d) / 50 + 2;
	let stab = 1;
	if (atkTypes.includes(type) || origTypes.includes(type)) stab = 1.5;
	if ((opts.tera || att.terastallized) && att.teraType === type && origTypes.includes(type)) stab = 2;
	if (att.ability === 'adaptability' && stab > 1) stab = 2;
	dmg *= stab * Math.pow(2, Dex.getEffectiveness(type, defTypes)) * 0.925;
	if (att.item === 'lifeorb') dmg *= 1.3;
	if (att.item === 'choiceband' && phys) dmg *= 1.5;
	if (att.item === 'choicespecs' && !phys) dmg *= 1.5;
	if (att.status === 'brn' && phys && att.ability !== 'guts') dmg *= 0.5;
	if (def.ability === 'multiscale' && def.hp === def.maxhp) dmg *= 0.5;
	return dmg / def.maxhp;
}
const accuracy = m => (m.accuracy === true ? 1 : m.accuracy / 100);

const GUESS = {};
function guessMove(type, cat) {
	const k = type + cat;
	if (!(k in GUESS)) GUESS[k] = Dex.moves.all().find(m => m.type === type && m.category === cat &&
		m.basePower >= 80 && m.basePower <= 95 && !m.isNonstandard) || null;
	return GUESS[k];
}
// What the foe might hit us with: revealed moves, else a 90 BP STAB guess per type.
function foeThreat(foe, me) {
	let best = 0;
	const revealed = foe.moveSlots.filter(s => s.used).map(s => s.id);
	for (const id of revealed) best = Math.max(best, estDamage(foe, me, id) * accuracy(Dex.moves.get(id)));
	if (revealed.length < 4) {
		for (const t of foe.getTypes()) {
			const guess = guessMove(t, foe.storedStats.atk > foe.storedStats.spa ? 'Physical' : 'Special');
			if (guess) best = Math.max(best, estDamage(foe, me, guess.id));
		}
	}
	return best;
}

function matchup(me, foe) {
	if (!foe || foe.fainted) return 0;
	const off = Math.max(0, ...me.moveSlots.map(s => estDamage(me, foe, s.id)));
	const def = foeThreat(foe, me);
	const faster = stat(me, 'spe') > stat(foe, 'spe') ? 0.15 : -0.15;
	return off - def + faster + hpFrac(me) * 0.3;
}

// ---------- Decision context ----------
function context(battle, side) {
	const req = side.activeRequest;
	const me = side.active[0];
	const foeSide = side.foe;
	const foe = foeSide.active[0];
	const bench = side.pokemon.map((p, i) => ({p, slot: i + 1})).filter(x => !x.p.fainted && !x.p.isActive);
	return {battle, side, req, me, foe, foeSide, bench, rng: battle.prng};
}

function legalMoves(ctx) {
	const a = ctx.req.active[0];
	return a.moves.map((m, i) => ({...m, slot: i + 1, data: Dex.moves.get(m.id)}))
		.filter(m => !m.disabled && (m.pp === undefined || m.pp > 0 || m.id === 'struggle'));
}
const canSwitch = ctx => !ctx.req.active[0].trapped && !ctx.req.active[0].maybeTrapped && ctx.bench.length > 0;
const bestSwitch = ctx => ctx.bench.slice().sort((x, y) => matchup(y.p, ctx.foe) - matchup(x.p, ctx.foe))[0];

function scoredAttacks(ctx, {tera = false, accWeight = 1} = {}) {
	return legalMoves(ctx).map(m => {
		const raw = estDamage(ctx.me, ctx.foe, m.id, {tera});
		const exp = raw * Math.pow(accuracy(m.data), accWeight);
		const prio = m.data.priority || 0;
		return {m, raw, exp, prio};
	});
}

function pick(arr, f) { let b = null, bs = -Infinity; for (const x of arr) { const s = f(x); if (s > bs) { bs = s; b = x; } } return b; }

function moveChoice(m, tera) { return `move ${m.slot}${tera ? ' terastallize' : ''}`; }

// ---------- Shared building blocks ----------
function attack(ctx, opts = {}) {
	const canTera = !!ctx.req.active[0].canTerastallize && opts.allowTera;
	let best = pick(scoredAttacks(ctx, opts), x => x.exp);
	let tera = false;
	if (canTera) {
		const tb = pick(scoredAttacks(ctx, {...opts, tera: true}), x => x.exp);
		if (tb && best && tb.exp > best.exp * (opts.teraGain || 1.2)) { best = tb; tera = true; }
	}
	if (!best || best.exp <= 0) {
		const any = legalMoves(ctx);
		return moveChoice(any[Math.floor(ctx.rng.random() * any.length)]);
	}
	return moveChoice(best.m, tera);
}
function findMove(ctx, pred) { return legalMoves(ctx).find(m => pred(m.data, m)); }
const isBoost = d => d.category === 'Status' && d.target === 'self' && d.boosts && Object.values(d.boosts).some(v => v > 0);
const isRecover = d => d.category === 'Status' && (d.heal || ['rest', 'strengthsap', 'morningsun', 'moonlight', 'synthesis', 'shoredup'].includes(d.id));
const isStatus = d => d.category === 'Status' && (d.status || d.id === 'yawn') && d.target !== 'self';
function statusUseful(ctx, d) {
	const f = ctx.foe;
	if (f.status || f.volatiles.substitute) return false;
	const ft = f.getTypes();
	if (d.status === 'brn' && (ft.includes('Fire') || f.storedStats.atk < f.storedStats.spa)) return false;
	if ((d.status === 'tox' || d.status === 'psn') && (ft.includes('Poison') || ft.includes('Steel'))) return false;
	if (d.status === 'par' && (ft.includes('Electric') || (d.type === 'Electric' && ft.includes('Ground')))) return false;
	if (d.status === 'slp' && (d.flags.powder && ft.includes('Grass'))) return false;
	return Dex.getImmunity(d.type, ft) || d.id === 'toxic' && !ft.includes('Steel');
}
function hazardMove(ctx) {
	const sc = ctx.foeSide.sideConditions;
	const alive = ctx.foeSide.pokemon.filter(p => !p.fainted).length;
	if (alive < 3) return null;
	return findMove(ctx, d => HAZARDS.has(d.id) && (
		(d.id === 'stealthrock' && !sc.stealthrock) || (d.id === 'stickyweb' && !sc.stickyweb) ||
		(d.id === 'spikes' && (!sc.spikes || sc.spikes.layers < 3)) ||
		(d.id === 'toxicspikes' && (!sc.toxicspikes || sc.toxicspikes.layers < 2))));
}
function koAvailable(ctx) {
	const s = pick(scoredAttacks(ctx), x => x.exp);
	return s && s.raw * 0.95 >= hpFrac(ctx.foe) ? s : null;
}
const outspeeds = ctx => stat(ctx.me, 'spe') > stat(ctx.foe, 'spe');

// ---------- The 14 bots ----------
const BOTS = {
	'Blaze': {style: 'Max Damage', desc: 'Always clicks the hardest-hitting move.',
		turn: ctx => attack(ctx, {accWeight: 0})},
	'Titan': {style: 'Tera Aggro', desc: 'Max damage and Terastallizes the moment it boosts output.',
		turn: ctx => attack(ctx, {allowTera: true, teraGain: 1.05})},
	'Sage': {style: 'Setup Sweeper', desc: 'Boosts when healthy and not threatened, then sweeps.',
		turn: ctx => {
			const b = findMove(ctx, d => isBoost(d));
			const boosts = Object.values(ctx.me.boosts).reduce((a, x) => a + Math.max(0, x), 0);
			if (b && boosts < 4 && hpFrac(ctx.me) > 0.55 && foeThreat(ctx.foe, ctx.me) < 0.45) return moveChoice(b);
			return attack(ctx, {allowTera: boosts >= 2});
		}},
	'Warden': {style: 'Defensive Wall', desc: 'Switches to resists, recovers, chips with status.',
		turn: ctx => {
			if (canSwitch(ctx) && foeThreat(ctx.foe, ctx.me) > 0.6) {
				const s = bestSwitch(ctx);
				if (s && foeThreat(ctx.foe, s.p) < foeThreat(ctx.foe, ctx.me) * 0.6) return `switch ${s.slot}`;
			}
			const r = findMove(ctx, isRecover);
			if (r && hpFrac(ctx.me) < 0.55) return moveChoice(r);
			const st = findMove(ctx, d => isStatus(d) && statusUseful(ctx, d));
			if (st) return moveChoice(st);
			return attack(ctx, {allowTera: false});
		}},
	'Volt': {style: 'Pivot', desc: 'U-turns and switches to keep the best matchup on the field.',
		turn: ctx => {
			const piv = findMove(ctx, d => d.selfSwitch && d.category !== 'Status');
			if (canSwitch(ctx) && matchup(ctx.me, ctx.foe) < -0.25) {
				if (piv && estDamage(ctx.me, ctx.foe, piv.id) > 0) return moveChoice(piv);
				const s = bestSwitch(ctx);
				if (s && matchup(s.p, ctx.foe) > matchup(ctx.me, ctx.foe) + 0.3) return `switch ${s.slot}`;
			}
			if (piv && ctx.bench.length && !koAvailable(ctx) && ctx.rng.random() < 0.5) return moveChoice(piv);
			return attack(ctx, {allowTera: hpFrac(ctx.foe) > 0.7});
		}},
	'Cairn': {style: 'Hazard Stacker', desc: 'Sets Stealth Rock and Spikes, then chips.',
		turn: ctx => {
			const h = hazardMove(ctx);
			if (h && hpFrac(ctx.me) > 0.3) return moveChoice(h);
			return attack(ctx, {allowTera: false});
		}},
	'Venom': {style: 'Status Spreader', desc: 'Burns, poisons and paralyzes healthy targets first.',
		turn: ctx => {
			const st = findMove(ctx, d => isStatus(d) && statusUseful(ctx, d));
			if (st && hpFrac(ctx.foe) > 0.4) return moveChoice(st);
			return attack(ctx, {allowTera: false});
		}},
	'Dash': {style: 'Speed Demon', desc: 'Hunts KOs with priority and leads with its fastest Pokémon.',
		turn: ctx => {
			const prio = pick(scoredAttacks(ctx).filter(x => x.prio > 0), x => x.exp);
			if (prio && prio.raw >= hpFrac(ctx.foe) * 0.95 && !outspeeds(ctx)) return moveChoice(prio.m);
			if (prio && hpFrac(ctx.me) < 0.25) return moveChoice(prio.m);
			return attack(ctx, {allowTera: true, teraGain: 1.3});
		},
		lead: side => side.pokemon.reduce((a, p, i) => stat(p, 'spe') > stat(side.pokemon[a], 'spe') ? i : a, 0)},
	'Lucky': {style: 'Gambler', desc: 'Picks moves by weighted dice — big, risky moves favored.',
		turn: ctx => {
			const opts = scoredAttacks(ctx).filter(x => x.raw > 0);
			if (!opts.length) return attack(ctx);
			const w = opts.map(x => Math.pow(x.raw, 2)); const tot = w.reduce((a, b) => a + b, 0);
			let r = ctx.rng.random() * tot;
			for (let i = 0; i < opts.length; i++) { r -= w[i]; if (r <= 0) return moveChoice(opts[i].m, ctx.req.active[0].canTerastallize && ctx.rng.random() < 0.15); }
			return moveChoice(opts[0].m);
		}},
	'Hawk': {style: 'Sniper', desc: 'Accuracy-weighted KO math; bails out if it will be KO\'d first.',
		turn: ctx => {
			const ko = koAvailable(ctx);
			if (ko && (outspeeds(ctx) || ko.prio > 0)) return moveChoice(ko.m);
			if (canSwitch(ctx) && !outspeeds(ctx) && foeThreat(ctx.foe, ctx.me) >= hpFrac(ctx.me)) {
				const s = bestSwitch(ctx);
				if (s && foeThreat(ctx.foe, s.p) < hpFrac(s.p) * 0.5) return `switch ${s.slot}`;
			}
			return attack(ctx, {allowTera: true, accWeight: 2});
		}},
	'Oracle': {style: 'Matchup Analyst', desc: 'One-turn lookahead weighing damage dealt vs. taken.',
		turn: ctx => {
			const threat = foeThreat(ctx.foe, ctx.me);
			const opts = [];
			for (const x of scoredAttacks(ctx, {accWeight: 1})) {
				const kills = x.raw >= hpFrac(ctx.foe);
				const first = outspeeds(ctx) || x.prio > 0;
				const dies = threat >= hpFrac(ctx.me);
				opts.push({c: moveChoice(x.m), v: Math.min(x.exp, hpFrac(ctx.foe)) + (kills && first ? 0.6 : 0) - (dies && !first ? 0.5 : 0)});
			}
			if (ctx.req.active[0].canTerastallize) for (const x of scoredAttacks(ctx, {tera: true})) {
				const kills = x.raw >= hpFrac(ctx.foe);
				opts.push({c: moveChoice(x.m, true), v: Math.min(x.exp, hpFrac(ctx.foe)) + (kills ? 0.4 : 0) - 0.12});
			}
			const b = findMove(ctx, isBoost);
			if (b && threat < 0.3 && hpFrac(ctx.me) > 0.7) opts.push({c: moveChoice(b), v: 0.45});
			const h = hazardMove(ctx);
			if (h && threat < 0.4) opts.push({c: moveChoice(h), v: 0.35});
			const r = findMove(ctx, isRecover);
			if (r && hpFrac(ctx.me) < 0.5 && threat < 0.5) opts.push({c: moveChoice(r), v: 0.5});
			if (canSwitch(ctx)) for (const s of ctx.bench) {
				opts.push({c: `switch ${s.slot}`, v: (matchup(s.p, ctx.foe) - matchup(ctx.me, ctx.foe)) * 0.6 - foeThreat(ctx.foe, s.p) * 0.5 - 0.1});
			}
			return pick(opts, o => o.v).c;
		}},
	'Rookie': {style: 'Random', desc: 'Picks a random legal action. The baseline.',
		turn: ctx => {
			const m = legalMoves(ctx);
			if (canSwitch(ctx) && ctx.rng.random() < 0.15) return `switch ${ctx.bench[Math.floor(ctx.rng.random() * ctx.bench.length)].slot}`;
			return moveChoice(m[Math.floor(ctx.rng.random() * m.length)]);
		},
		forced: ctx => `switch ${ctx.bench[Math.floor(ctx.rng.random() * ctx.bench.length)].slot}`},
	'Monk': {style: 'Stall', desc: 'Protect, Toxic, recovery and residual damage.',
		turn: ctx => {
			const r = findMove(ctx, isRecover);
			if (r && hpFrac(ctx.me) < 0.6) return moveChoice(r);
			const p = findMove(ctx, d => d.stallingMove);
			if (p && ctx.foe.status && ['tox', 'psn', 'brn'].includes(ctx.foe.status) && !ctx.me.volatiles.stall) return moveChoice(p);
			const st = findMove(ctx, d => isStatus(d) && statusUseful(ctx, d));
			if (st) return moveChoice(st);
			const h = hazardMove(ctx);
			if (h) return moveChoice(h);
			return attack(ctx, {allowTera: false});
		}},
	'Ace': {style: 'Balanced', desc: 'Blends hazards, setup, safe switches and tera timing.',
		turn: ctx => {
			const threat = foeThreat(ctx.foe, ctx.me);
			const ko = koAvailable(ctx);
			if (ko && (outspeeds(ctx) || ko.prio > 0 || threat < hpFrac(ctx.me))) return moveChoice(ko.m);
			if (canSwitch(ctx) && threat >= hpFrac(ctx.me) && !outspeeds(ctx)) {
				const s = bestSwitch(ctx);
				if (s && foeThreat(ctx.foe, s.p) < 0.45) return `switch ${s.slot}`;
			}
			const h = hazardMove(ctx);
			if (h && threat < 0.5 && ctx.battle.turn < 8) return moveChoice(h);
			const b = findMove(ctx, isBoost);
			if (b && threat < 0.35 && hpFrac(ctx.me) > 0.6 && (ctx.me.boosts.atk + ctx.me.boosts.spa) < 2) return moveChoice(b);
			const r = findMove(ctx, isRecover);
			if (r && hpFrac(ctx.me) < 0.45 && threat < 0.45) return moveChoice(r);
			const remaining = ctx.side.pokemon.filter(p => !p.fainted).length;
			return attack(ctx, {allowTera: remaining <= 4, teraGain: 1.15});
		}},
};

// Generic forced-switch: best matchup into the current foe.
function forcedSwitch(ctx) {
	if (!ctx.foe || ctx.foe.fainted) return `switch ${ctx.bench[0].slot}`;
	return `switch ${bestSwitch(ctx).slot}`;
}

function decide(name, battle, side) {
	const bot = BOTS[name];
	const req = side.activeRequest;
	if (req.teamPreview) {
		const n = side.pokemon.length;
		let order = [...Array(n).keys()];
		if (bot.lead) { const l = bot.lead(side); order = [l, ...order.filter(i => i !== l)]; }
		else if (name === 'Cairn' || name === 'Ace') {
			const l = side.pokemon.findIndex(p => p.moveSlots.some(s => s.id === 'stealthrock'));
			if (l > 0) order = [l, ...order.filter(i => i !== l)];
		}
		return 'team ' + order.map(i => i + 1).join('');
	}
	const ctx = context(battle, side);
	if (req.forceSwitch) return (bot.forced || forcedSwitch)(ctx);
	return bot.turn(ctx);
}

module.exports = {BOTS, decide, estDamage, matchup, foeThreat, scoredAttacks, legalMoves, findMove, isBoost,
	isRecover, isStatus, statusUseful, hazardMove, canSwitch, context, moveChoice, hpFrac, outspeeds, bestSwitch, forcedSwitch, stat};
