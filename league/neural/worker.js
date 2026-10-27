// Game generator for training. Modes:
//  'bc'  — a teacher (heuristic brain) plays; we record the teacher's choice for imitation.
//  'rl'  — the current net plays (sampling) vs self / a past snapshot / a heuristic brain; we record its decisions.
//  'eval'— greedy net vs a heuristic brain on mirrored teams; returns wins.
'use strict';
const {parentPort} = require('worker_threads');
const {runBattle} = require('../battle');
const {brain} = require('../brain');
const {neuralBrain, netsFromJSON} = require('./policy');
const {encode} = require('./features');
const FORMAT = 'gen9championscustomgame';

function mkRng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function teacherRecorder(genome, out) {
	const b = brain(genome);
	return (battle, side) => {
		const choice = b(battle, side);
		if (side.activeRequest.teamPreview) return choice;
		const {actions, g} = encode(battle, side);
		const k = actions.findIndex(a => a.choice === choice);
		if (k >= 0 && actions.length > 1) out.push({X: actions.map(a => a.x), g, a: k, n: actions.length});
		return choice;
	};
}

parentPort.on('message', msg => {
	const {id, mode, games} = msg;
	const nets = msg.nets ? netsFromJSON(msg.nets) : null;
	const old = msg.oldNets ? netsFromJSON(msg.oldNets) : null;
	const result = {id, samples: [], trajs: [], wins: 0, games: 0};
	for (const gm of games) {
		const rng = mkRng(gm.seed[0] * 7919 + gm.seed[1]);
		if (mode === 'bc') {
			const r = runBattle({format: FORMAT, seed: gm.seed,
				p1: {name: 'A', bot: teacherRecorder(gm.genomeA, result.samples), team: gm.teamA},
				p2: {name: 'B', bot: teacherRecorder(gm.genomeB, result.samples), team: gm.teamB}});
			result.games++;
		} else if (mode === 'rl') {
			const tA = [], tB = [];
			const bA = neuralBrain(nets, {mode: 'sample', rng, recorder: s => tA.push(s)});
			let bB;
			if (gm.opp === 'self') bB = neuralBrain(nets, {mode: 'sample', rng, recorder: s => tB.push(s)});
			else if (gm.opp === 'old') bB = neuralBrain(old, {mode: 'sample', rng});
			else bB = brain(gm.genomeB);
			const r = runBattle({format: FORMAT, seed: gm.seed, p1: {name: 'A', bot: bA, team: gm.teamA}, p2: {name: 'B', bot: bB, team: gm.teamB}});
			const zA = r.winnerName === 'A' ? 1 : r.winnerName === 'B' ? -1 : 0;
			if (tA.length) result.trajs.push({steps: tA, z: zA});
			if (tB.length) result.trajs.push({steps: tB, z: -zA});
			result.games++;
		} else if (mode === 'eval') {
			// same two teams, sides swapped each game: only the brains differ
			const net = neuralBrain(nets, {mode: 'greedy'});
			const swap = gm.swap;
			const N = {name: 'N', bot: net, team: swap ? gm.teamB : gm.teamA};
			const H = {name: 'H', bot: gm.oppNet ? neuralBrain(old, {mode: 'greedy'}) : brain(gm.genomeB), team: swap ? gm.teamA : gm.teamB};
			const r = runBattle({format: FORMAT, seed: gm.seed, p1: swap ? H : N, p2: swap ? N : H});
			if (r.winnerName === 'N') result.wins++;
			result.games++;
		}
	}
	parentPort.postMessage(result);
});
