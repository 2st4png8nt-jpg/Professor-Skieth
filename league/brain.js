// Learnable brain: one scoring policy driven by a genome of weights.
// Each agent's play style is a starting genome; evolution tunes it.
const A = require('./ai');

const RANGES = {
	dmg: [0.5, 2], ko: [0, 1.5], risk: [0, 1.5], acc: [0, 3], tera: [-0.3, 0.5], teraLate: [1, 6],
	setup: [0, 1.5], setupThreat: [0, 0.8], setupHp: [0.2, 1], maxBoost: [1, 6],
	haz: [0, 1.2], hazThreat: [0, 0.9], rec: [0, 2], recHp: [0.2, 0.9], recThreat: [0, 1],
	status: [0, 1], pivot: [0, 0.6], sw: [0, 2], swThreat: [0, 1.5], swCost: [-0.1, 0.6], prio: [0, 1],
};
const LABELS = {
	dmg: 'Damage focus', ko: 'KO hunting', risk: 'Fear of being KO\'d', acc: 'Accuracy caution', tera: 'Tera reluctance',
	teraLate: 'Saves Tera until ≤N left', setup: 'Setup drive', setupThreat: 'Setup risk tolerance', setupHp: 'HP needed to set up',
	maxBoost: 'Max boosts', haz: 'Hazard priority', hazThreat: 'Hazard risk tolerance', rec: 'Recovery drive',
	recHp: 'Heals below HP', recThreat: 'Heal risk tolerance', status: 'Status spreading', pivot: 'Pivot love',
	sw: 'Matchup switching', swThreat: 'Switch-in safety', swCost: 'Switch hesitation', prio: 'Priority finishing',
};
const BASE = {dmg: 1, ko: 0.6, risk: 0.5, acc: 1, tera: 0.12, teraLate: 6, setup: 0.45, setupThreat: 0.3, setupHp: 0.7,
	maxBoost: 4, haz: 0.35, hazThreat: 0.4, rec: 0.9, recHp: 0.5, recThreat: 0.5, status: 0.3, pivot: 0.05,
	sw: 0.6, swThreat: 0.5, swCost: 0.1, prio: 0.2};
const STYLE_SEEDS = {
	Oracle: {}, Ace: {haz: 0.5, setup: 0.5}, Sage: {setup: 0.9, setupThreat: 0.45, setupHp: 0.55},
	Cairn: {haz: 0.9, hazThreat: 0.7}, Blaze: {acc: 0, sw: 0, status: 0, haz: 0, setup: 0, rec: 0, risk: 0, ko: 0.3},
	Dash: {prio: 0.6, tera: 0.05}, Monk: {rec: 1.5, recHp: 0.65, status: 0.6, haz: 0.5, setup: 0.1},
	Hawk: {acc: 2, risk: 0.9, ko: 0.8, sw: 0.8}, Volt: {pivot: 0.25, sw: 1.0, swCost: 0},
	Warden: {sw: 1.2, swThreat: 1, rec: 1.3, status: 0.5}, Titan: {tera: -0.1}, Venom: {status: 0.8},
	Lucky: {acc: 0, risk: 0}, Rookie: {},
};
const seedGenome = name => ({...BASE, ...(STYLE_SEEDS[name] || {})});

function mutate(g, rng, scale = 0.18) {
	const out = {...g};
	for (const k of Object.keys(RANGES)) {
		if (rng() > 0.5) continue; // mutate about half the genes
		const [lo, hi] = RANGES[k];
		const n = Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());
		out[k] = Math.min(hi, Math.max(lo, out[k] + n * scale * (hi - lo)));
	}
	return out;
}
const average = gs => Object.fromEntries(Object.keys(RANGES).map(k => [k, gs.reduce((a, g) => a + g[k], 0) / gs.length]));

function brain(g) {
	return (battle, side) => {
		const req = side.activeRequest;
		if (req.teamPreview) {
			const l = side.pokemon.findIndex(p => p.moveSlots.some(s => s.id === 'stealthrock'));
			const order = [...Array(side.pokemon.length).keys()];
			const o = g.haz > 0.5 && l > 0 ? [l, ...order.filter(i => i !== l)] : order;
			return 'team ' + o.map(i => i + 1).join('');
		}
		const ctx = A.context(battle, side);
		if (req.forceSwitch) return A.forcedSwitch(ctx);
		const me = ctx.me, foe = ctx.foe, myHp = A.hpFrac(me), foeHp = A.hpFrac(foe);
		const threat = A.foeThreat(foe, me);
		const fast = A.outspeeds(ctx);
		const opts = [];
		const score = (x, tera) => {
			const first = fast || x.prio > 0;
			const kills = x.raw >= foeHp * 0.97;
			const dies = threat >= myHp;
			let v = g.dmg * Math.min(x.exp, foeHp);
			if (kills && first) v += g.ko; else if (kills && !dies) v += g.ko * 0.6;
			if (dies && !first) v -= g.risk;
			if (x.prio > 0 && (kills || myHp < 0.3)) v += g.prio;
			if (x.m.data.selfSwitch && ctx.bench.length) v += g.pivot;
			if (tera) v -= g.tera;
			return v;
		};
		for (const x of A.scoredAttacks(ctx, {accWeight: g.acc})) opts.push({c: A.moveChoice(x.m), v: score(x, false)});
		const alive = side.pokemon.filter(p => !p.fainted).length;
		if (req.active[0].canTerastallize && alive <= Math.round(g.teraLate)) {
			for (const x of A.scoredAttacks(ctx, {tera: true, accWeight: g.acc})) opts.push({c: A.moveChoice(x.m, true), v: score(x, true)});
		}
		const boosts = Object.values(me.boosts).reduce((a, b) => a + Math.max(0, b), 0);
		const b = A.findMove(ctx, A.isBoost);
		if (b && threat < g.setupThreat && myHp > g.setupHp && boosts < g.maxBoost) opts.push({c: A.moveChoice(b), v: g.setup});
		const h = A.hazardMove(ctx);
		if (h && threat < g.hazThreat) opts.push({c: A.moveChoice(h), v: g.haz});
		const r = A.findMove(ctx, A.isRecover);
		if (r && myHp < g.recHp && threat < g.recThreat + myHp * 0.5) opts.push({c: A.moveChoice(r), v: g.rec * (1 - myHp)});
		const st = A.findMove(ctx, d => A.isStatus(d) && A.statusUseful(ctx, d));
		if (st && foeHp > 0.4) opts.push({c: A.moveChoice(st), v: g.status});
		if (A.canSwitch(ctx) && g.sw > 0) {
			const here = A.matchup(me, foe);
			for (const s of ctx.bench) {
				opts.push({c: `switch ${s.slot}`, v: g.sw * (A.matchup(s.p, foe) - here) - g.swThreat * A.foeThreat(foe, s.p) - g.swCost});
			}
		}
		let best = opts[0];
		for (const o of opts) if (o.v > best.v) best = o;
		return best ? best.c : 'default';
	};
}

module.exports = {brain, seedGenome, mutate, average, RANGES, LABELS};
