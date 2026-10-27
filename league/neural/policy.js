// The neural brain: an action-scoring policy network + a value network (win chance).
'use strict';
const {MLP} = require('./nn');
const {encode, G, IN} = require('./features');

const H = 64;
function makeNets(rng) {
	return {pol: new MLP([IN, H, H, 1], rng), val: new MLP([G, H, 1], rng)};
}
function netsFromJSON(j) { return {pol: MLP.fromJSON(j.pol), val: MLP.fromJSON(j.val)}; }

function softmax(scores) {
	const m = Math.max(...scores);
	const e = scores.map(s => Math.exp(s - m));
	const t = e.reduce((a, b) => a + b, 0);
	return e.map(x => x / t);
}

// Returns a brain function usable by runBattle: (battle, side) => choice string.
// mode: 'sample' (training/exploration) or 'greedy' (best move). recorder(sample) captures decisions.
function neuralBrain(nets, {mode = 'greedy', rng = Math.random, recorder = null, temperature = 1} = {}) {
	return (battle, side) => {
		const req = side.activeRequest;
		if (req.teamPreview) return 'default';
		const {actions, g} = encode(battle, side);
		if (!actions.length) return 'default';
		const scores = actions.map(a => nets.pol.forward(a.x)[0] / temperature);
		const probs = softmax(scores);
		let k = 0;
		if (mode === 'sample') {
			let r = rng(); k = probs.length - 1;
			for (let i = 0; i < probs.length; i++) { r -= probs[i]; if (r <= 0) { k = i; break; } }
		} else {
			for (let i = 1; i < probs.length; i++) if (probs[i] > probs[k]) k = i;
		}
		if (recorder) recorder({X: actions.map(a => a.x), g, a: k, logp: Math.log(probs[k] + 1e-12), n: actions.length});
		return actions[k].choice;
	};
}

module.exports = {makeNets, netsFromJSON, neuralBrain, softmax, encode};
