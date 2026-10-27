// Trains one shared neural brain for the whole league.
//   Phase A (imitation): copy Red's v110 brain (the Grand Champion) for a strong start.
//   Phase B (self-play RL, PPO): play vs itself, past versions, and every league brain; learn from wins/losses.
// Teams come from the whole league (gyms, champions) plus random Champions teams, so the brain
// learns to pilot every team it will be given. Checkpoints + an eval log are written to output/neural/.
'use strict';
const fs = require('fs');
const path = require('path');
const {Worker} = require('worker_threads');
const {Teams} = require('pokemon-showdown');
process.env.SEASON = '2';
const {randomTeam} = require('../runner');
const {seedGenome} = require('../brain');
const {makeNets, netsFromJSON, softmax} = require('./policy');
const {Adam} = require('./nn');
const {G} = require('./features');

const OUT = path.join(__dirname, '..', 'output', 'neural');
fs.mkdirSync(OUT, {recursive: true});
const MINUTES = Number(process.env.TRAIN_MINUTES) || 240;
const BC_GAMES = Number(process.env.BC_GAMES) || 1200;
const RL_GAMES = 240, EPOCHS = 3, MB = 256, CLIP = 0.2, ENT = 0.01, LAMBDA = 0.95, EVAL_EVERY = 10;

let s0 = 99;
const rng = () => { s0 |= 0; s0 = s0 + 0x6D2B79F5 | 0; let t = Math.imul(s0 ^ s0 >>> 15, 1 | s0); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const seed4 = () => [1, 2, 3, 4].map(() => 1 + Math.floor(rng() * 60000));
const pick = a => a[Math.floor(rng() * a.length)];

// ----- League teams and brains -----
const out = p => path.join(__dirname, '..', 'output', p);
const lv50 = t => { const x = Teams.import(t); x.forEach(p => { p.level = 50; }); return Teams.pack(x); };
const IMP = JSON.parse(fs.readFileSync(out('gyms_improved.json')));
const S2 = JSON.parse(fs.readFileSync(out('gauntlet-s2/gauntlet.json')));
const GYM2 = require('../gym_teams_champions');
const leagueTeams = [], leagueBrains = [];
for (const [k, g] of Object.entries(IMP)) { leagueTeams.push(lv50(g.teamText)); leagueBrains.push({name: k, genome: g.genome}); }
for (const k of Object.keys(IMP)) leagueTeams.push(lv50(GYM2[k].team));
leagueTeams.push(lv50(GYM2.CHAMPION), lv50(S2.championRun.teamText));
const volt = JSON.parse(fs.readFileSync(out('volt_brain.json')));
leagueBrains.push({name: 'Volt', genome: volt.genome});
const champs = {};
for (const r of ['Red', 'Blue', 'Skeith']) {
	const c = JSON.parse(fs.readFileSync(out(`s4-${r.toLowerCase()}/champion.json`)));
	leagueTeams.push(lv50(c.teamText)); leagueBrains.push({name: r, genome: c.genome}); champs[r] = c;
}
const TEACHER = champs.Red.genome;
const teamFor = () => rng() < 0.5 ? pick(leagueTeams) : Teams.pack(randomTeam(seed4()));

// ----- Workers -----
const N = 2;
const workers = Array.from({length: N}, () => new Worker(path.join(__dirname, 'worker.js')));
const pending = new Map(); let jid = 0;
workers.forEach(w => w.on('message', m => { pending.get(m.id)(m); pending.delete(m.id); }));
const run = (mode, games, extra = {}) => Promise.all(workers.map((w, i) => new Promise(res => {
	const id = ++jid; pending.set(id, res);
	w.postMessage({id, mode, games: games.filter((_, j) => j % N === i), ...extra});
}))).then(rs => ({samples: rs.flatMap(r => r.samples), trajs: rs.flatMap(r => r.trajs), wins: rs.reduce((a, r) => a + r.wins, 0), games: rs.reduce((a, r) => a + r.games, 0)}));

// ----- Learning -----
let nets = makeNets(rng);
const LR = Number(process.env.LR) || 1e-3;
const optP = new Adam(nets.pol, LR), optV = new Adam(nets.val, LR);
const log = [];
const t0 = Date.now();
const mins = () => (Date.now() - t0) / 60000;
const save = (name, extra = {}) => fs.writeFileSync(path.join(OUT, name), JSON.stringify({pol: nets.pol.toJSON(), val: nets.val.toJSON(), ...extra}));

// One gradient pass on the policy for a sample, given dLoss/dScore for each action.
function polGrad(sample, dScores, grads) {
	for (let i = 0; i < sample.n; i++) {
		if (dScores[i] === 0) continue;
		const c = {}; nets.pol.forward(sample.X[i], c);
		nets.pol.backward(c, [dScores[i]], grads);
	}
}
function scores(sample) { const s = new Array(sample.n); for (let i = 0; i < sample.n; i++) s[i] = nets.pol.forward(sample.X[i])[0]; return s; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function evaluate(tag) {
	// greedy net vs each league brain, mirrored teams (team luck cancels), 8 games each
	const games = [];
	for (const b of leagueBrains) for (let i = 0; i < 8; i++) {
		const tA = teamFor(), tB = teamFor(), sd = seed4();
		games.push({seed: sd, teamA: tA, teamB: tB, genomeB: b.genome, swap: false, who: b.name}, {seed: [sd[0], sd[1] + 1, sd[2], sd[3]], teamA: tA, teamB: tB, genomeB: b.genome, swap: true, who: b.name});
	}
	const r = await run('eval', games, {nets: {pol: nets.pol.toJSON(), val: nets.val.toJSON()}});
	const rate = r.wins / r.games;
	console.log(`[eval ${tag}] neural vs league brains: ${(rate * 100).toFixed(1)}% (${r.wins}/${r.games}) | ${mins().toFixed(1)} min`);
	return rate;
}

(async () => {
	let best = 0;
	const snapshots = [];
	const RESUME = process.env.RESUME === '1' && fs.existsSync(path.join(OUT, 'latest.json'));
	if (RESUME) {
		nets = netsFromJSON(JSON.parse(fs.readFileSync(path.join(OUT, 'latest.json'))));
		optP.net = nets.pol; optV.net = nets.val;
		const bj = JSON.parse(fs.readFileSync(path.join(OUT, 'best.json')));
		best = bj.winRate;
		log.push(...JSON.parse(fs.readFileSync(path.join(OUT, 'log.json'))));
		snapshots.push({pol: bj.pol, val: bj.val}, {pol: nets.pol.toJSON(), val: nets.val.toJSON()});
		console.log(`resumed from iter ${JSON.parse(fs.readFileSync(path.join(OUT, 'latest.json'))).iter}, best ${(best * 100).toFixed(1)}%`);
	} else {
	// ===== Phase A: imitation =====
	const bcGames = Array.from({length: BC_GAMES}, () => ({seed: seed4(), teamA: teamFor(), teamB: teamFor(),
		genomeA: rng() < 0.6 ? TEACHER : pick(leagueBrains).genome, genomeB: rng() < 0.6 ? TEACHER : pick(leagueBrains).genome}));
	const bc = await run('bc', bcGames);
	console.log(`imitation data: ${bc.samples.length} decisions from ${bc.games} games | ${mins().toFixed(1)} min`);
	for (let ep = 0; ep < 6; ep++) {
		shuffle(bc.samples); let loss = 0, acc = 0;
		for (let b = 0; b < bc.samples.length; b += MB) {
			const batch = bc.samples.slice(b, b + MB); const gr = nets.pol.zeroGrads();
			for (const s of batch) {
				const p = softmax(scores(s)); loss -= Math.log(p[s.a] + 1e-12);
				if (p.indexOf(Math.max(...p)) === s.a) acc++;
				polGrad(s, p.map((pi, i) => pi - (i === s.a ? 1 : 0)), gr);
			}
			optP.step(gr, 1 / batch.length);
		}
		console.log(`imitation epoch ${ep + 1}: loss ${(loss / bc.samples.length).toFixed(3)}, matches teacher ${(100 * acc / bc.samples.length).toFixed(1)}% | ${mins().toFixed(1)} min`);
	}
	save('bc.json');
	best = await evaluate('after imitation');
	log.push({iter: 0, phase: 'imitation', minutes: mins(), winRate: best});
	save('best.json', {winRate: best, iter: 0});
	snapshots.push({pol: nets.pol.toJSON(), val: nets.val.toJSON()});
	}

	// ===== Phase B: self-play RL (PPO) =====
	const prev = RESUME ? JSON.parse(fs.readFileSync(path.join(OUT, 'latest.json'))) : {iter: 0, totalGames: 0};
	let iter = prev.iter || 0, totalGames = prev.totalGames || 0;
	while (mins() < MINUTES) {
		iter++;
		const old = pick(snapshots);
		const games = Array.from({length: RL_GAMES}, () => {
			const u = rng();
			const opp = u < 0.5 ? 'self' : u < 0.7 ? 'old' : 'league';
			return {seed: seed4(), teamA: teamFor(), teamB: teamFor(), opp, genomeB: pick(leagueBrains).genome};
		});
		const r = await run('rl', games, {nets: {pol: nets.pol.toJSON(), val: nets.val.toJSON()}, oldNets: old});
		totalGames += r.games;
		// advantages (GAE, undiscounted) from the value net
		const samples = [];
		let wins = 0, decided = 0;
		for (const t of r.trajs) {
			const V = t.steps.map(s => nets.val.forward(s.g)[0]);
			let adv = 0;
			for (let i = t.steps.length - 1; i >= 0; i--) {
				const next = i === t.steps.length - 1 ? t.z : V[i + 1];
				const delta = next - V[i];
				adv = delta + LAMBDA * adv;
				t.steps[i].adv = adv; t.steps[i].ret = adv + V[i];
				samples.push(t.steps[i]);
			}
			if (t.z !== 0) { decided++; if (t.z > 0) wins++; }
		}
		const mean = samples.reduce((a, s) => a + s.adv, 0) / samples.length;
		const sd = Math.sqrt(samples.reduce((a, s) => a + (s.adv - mean) ** 2, 0) / samples.length) + 1e-8;
		samples.forEach(s => { s.nadv = (s.adv - mean) / sd; });
		let pl = 0, vl = 0, ent = 0, clipped = 0;
		for (let ep = 0; ep < EPOCHS; ep++) {
			shuffle(samples);
			for (let b = 0; b < samples.length; b += MB) {
				const batch = samples.slice(b, b + MB);
				const gP = nets.pol.zeroGrads(), gV = nets.val.zeroGrads();
				for (const s of batch) {
					const p = softmax(scores(s));
					const logp = Math.log(p[s.a] + 1e-12), ratio = Math.exp(logp - s.logp), A = s.nadv;
					const H = -p.reduce((a, pi) => a + (pi > 0 ? pi * Math.log(pi) : 0), 0);
					ent += H;
					const isClipped = (A > 0 && ratio > 1 + CLIP) || (A < 0 && ratio < 1 - CLIP);
					if (isClipped) clipped++;
					pl -= Math.min(ratio * A, Math.max(1 - CLIP, Math.min(1 + CLIP, ratio)) * A);
					const d = p.map((pi, i) => (isClipped ? 0 : -A * ratio * ((i === s.a ? 1 : 0) - pi)) + ENT * pi * (Math.log(pi + 1e-12) + H));
					polGrad(s, d, gP);
					const c = {}; const v = nets.val.forward(s.g, c)[0];
					vl += (v - s.ret) ** 2;
					nets.val.backward(c, [v - s.ret], gV);
				}
				optP.step(gP, 1 / batch.length, 0.5);
				optV.step(gV, 1 / batch.length, 1.0);
			}
		}
		const n = samples.length * EPOCHS;
		console.log(`iter ${iter}: ${r.games} games (${totalGames} total), ${samples.length} decisions, win ${(100 * wins / Math.max(1, decided)).toFixed(0)}% | policy ${(pl / n).toFixed(3)} value ${(vl / n).toFixed(3)} entropy ${(ent / n).toFixed(2)} clipped ${(100 * clipped / n).toFixed(0)}% | ${mins().toFixed(1)} min`);
		if (iter % 5 === 0) { snapshots.push({pol: nets.pol.toJSON(), val: nets.val.toJSON()}); if (snapshots.length > 8) snapshots.splice(1, 1); }
		save('latest.json', {iter, totalGames});
		if (iter % EVAL_EVERY === 0) {
			const wr = await evaluate(`iter ${iter}`);
			log.push({iter, phase: 'self-play', minutes: mins(), totalGames, winRate: wr});
			if (wr >= best) { best = wr; save('best.json', {winRate: wr, iter, totalGames}); console.log(`  new best (${(wr * 100).toFixed(1)}%)`); }
		}
		fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log));
	}
	console.log(`\nDONE: ${iter} iterations, ${totalGames} self-play games, best eval ${(best * 100).toFixed(1)}%`);
	workers.forEach(w => w.terminate());
})();
