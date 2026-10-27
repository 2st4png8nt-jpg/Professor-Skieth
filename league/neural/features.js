// Turns a battle decision into numbers the network can read.
// Each legal action gets a feature vector = [global state (G) | action features (A)].
// The network scores every action; the highest-probability one is played.
'use strict';
const {Dex} = require('pokemon-showdown');
const A = require('../ai');

const G = 22, F = 28, IN = G + F;
const clip = (x, lo = -3, hi = 3) => Math.max(lo, Math.min(hi, x));
const sideHazards = sc => [sc.stealthrock ? 1 : 0, sc.spikes ? sc.spikes.layers / 3 : 0, sc.toxicspikes ? sc.toxicspikes.layers / 2 : 0, sc.stickyweb ? 1 : 0];
const boostSum = p => Object.values(p.boosts).reduce((a, b) => a + b, 0) / 6;

function globalFeatures(ctx, threat, best) {
	const {me, foe, side, foeSide, battle} = ctx;
	const mine = side.pokemon, theirs = foeSide.pokemon;
	const alive = arr => arr.filter(p => !p.fainted).length / 6;
	const teamHp = arr => arr.reduce((a, p) => a + (p.fainted ? 0 : p.hp / p.maxhp), 0) / 6;
	const g = new Float64Array(G);
	g[0] = A.hpFrac(me); g[1] = A.hpFrac(foe);
	g[2] = alive(mine); g[3] = alive(theirs);
	g[4] = teamHp(mine); g[5] = teamHp(theirs);
	g[6] = A.outspeeds(ctx) ? 1 : (A.stat(me, 'spe') === A.stat(foe, 'spe') ? 0 : -1);
	g[7] = boostSum(me); g[8] = boostSum(foe);
	g[9] = me.status ? 1 : 0; g[10] = foe.status ? 1 : 0;
	g[11] = clip(threat); g[12] = clip(best);
	const h1 = sideHazards(side.sideConditions), h2 = sideHazards(foeSide.sideConditions);
	g[13] = h1[0] + h1[1]; g[14] = h2[0] + h2[1]; g[15] = h1[2] + h1[3]; g[16] = h2[2] + h2[3];
	g[17] = Math.min(1, battle.turn / 40);
	g[18] = ctx.req.active && ctx.req.active[0] && ctx.req.active[0].canTerastallize ? 1 : 0;
	g[19] = me.terastallized ? 1 : 0; g[20] = foe.terastallized ? 1 : 0;
	g[21] = 1; // bias-like constant
	return g;
}

// Builds the list of legal actions with features. Returns {actions:[{choice, x}], g}.
function encode(battle, side) {
	const req = side.activeRequest;
	const ctx = A.context(battle, side);
	const forced = !!req.forceSwitch;
	const {me, foe} = ctx;
	const threat = foe && !foe.fainted && me ? A.foeThreat(foe, me) : 0;
	const attacks = !forced ? A.scoredAttacks(ctx) : [];
	const best = attacks.reduce((a, x) => Math.max(a, x.raw), 0);
	const g = foe && me ? globalFeatures(ctx, threat, best) : new Float64Array(G);
	const actions = [];
	const myHp = me ? A.hpFrac(me) : 0, foeHp = foe ? A.hpFrac(foe) : 1;
	const fast = me && foe ? A.outspeeds(ctx) : false;
	const hereMatch = me && foe && !forced ? A.matchup(me, foe) : 0;
	const mk = (choice, f) => { const x = new Float64Array(IN); x.set(g, 0); for (let i = 0; i < F; i++) x[G + i] = f[i] || 0; actions.push({choice, x}); };

	if (!forced) {
		const canTera = !!req.active[0].canTerastallize;
		const megaTag = req.active[0].canMegaEvo ? ' mega' : '';
		const boosts = Object.values(me.boosts).reduce((a, b) => a + Math.max(0, b), 0);
		const moveFeat = (m, tera) => {
			const d = m.data;
			const raw = A.estDamage(me, foe, m.id, {tera});
			const acc = d.accuracy === true ? 1 : d.accuracy / 100;
			const prio = d.priority || 0;
			const first = fast || prio > 0;
			const kills = raw >= foeHp * 0.97;
			const eff = d.category !== 'Status' && foe ? Dex.getEffectiveness(d.type, foe.getTypes()) : 0;
			const f = new Float64Array(F);
			f[0] = 1; f[1] = 0; f[2] = tera ? 1 : 0;
			f[3] = clip(Math.min(raw * acc, foeHp)); f[4] = clip(raw);
			f[5] = kills ? 1 : 0; f[6] = kills && first ? 1 : 0;
			f[7] = acc; f[8] = prio > 0 ? 1 : (prio < 0 ? -1 : 0);
			f[9] = threat >= myHp && !first ? 1 : 0;
			f[10] = A.isBoost(d) ? 1 : 0; f[11] = A.isBoost(d) ? boosts / 6 : 0;
			f[12] = A.isRecover(d) ? 1 - myHp : 0;
			f[13] = A.hazardMove(ctx) && A.hazardMove(ctx).id === m.id ? 1 : 0;
			f[14] = A.isStatus(d) && A.statusUseful(ctx, d) ? 1 : 0;
			f[15] = d.selfSwitch && ctx.bench.length ? 1 : 0;
			f[16] = d.stallingMove ? 1 : 0;
			f[17] = clip(eff, -2, 2) / 2;
			f[18] = d.category === 'Status' ? 1 : 0;
			f[19] = me.volatiles.choicelock ? 1 : 0;
			f[20] = d.recoil || d.mindBlownRecoil ? 1 : 0;
			f[21] = (d.self && d.self.boosts && Object.values(d.self.boosts).some(v => v < 0)) ? 1 : 0;
			return f;
		};
		for (const m of A.legalMoves(ctx)) {
			mk(`move ${m.slot}${megaTag}`, moveFeat(m, false));
			if (canTera) mk(`move ${m.slot} terastallize`, moveFeat(m, true));
		}
	}
	const trapped = !forced && (req.active[0].trapped || req.active[0].maybeTrapped);
	if (!trapped) {
		for (const s of ctx.bench) {
			const p = s.p;
			const f = new Float64Array(F);
			f[1] = 1;
			const tThreat = foe && !foe.fainted ? A.foeThreat(foe, p) : 0;
			const m = foe && !foe.fainted ? A.matchup(p, foe) : 0;
			const off = foe && !foe.fainted ? Math.max(0, ...p.moveSlots.map(x => A.estDamage(p, foe, x.id))) : 0;
			f[22] = A.hpFrac(p);
			f[23] = clip(m - hereMatch);
			f[24] = clip(tThreat);
			f[25] = foe && !foe.fainted && A.stat(p, 'spe') > A.stat(foe, 'spe') ? 1 : -1;
			f[26] = clip(off);
			f[27] = forced ? 1 : 0;
			mk(`switch ${s.slot}`, f);
		}
	}
	return {actions, g};
}

module.exports = {encode, G, F, IN};
