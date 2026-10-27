// Tiny dependency-free neural network: fully connected layers with tanh, manual backprop, Adam.
'use strict';

function randn(rng) {
	const u = rng() || 1e-9, v = rng();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class MLP {
	// sizes: [in, h1, h2, ..., out]; tanh on hidden layers, linear output.
	constructor(sizes, rng = Math.random) {
		this.sizes = sizes;
		this.W = []; this.b = [];
		for (let l = 0; l < sizes.length - 1; l++) {
			const fanIn = sizes[l], fanOut = sizes[l + 1];
			const w = new Float64Array(fanIn * fanOut);
			const scale = (l === sizes.length - 2 ? 0.1 : 1) * Math.sqrt(1 / fanIn);
			for (let i = 0; i < w.length; i++) w[i] = randn(rng) * scale;
			this.W.push(w); this.b.push(new Float64Array(fanOut));
		}
	}
	// x: Float64Array(in) → output Float64Array(out); keeps activations if cache given
	forward(x, cache) {
		let a = x;
		if (cache) cache.acts = [x];
		for (let l = 0; l < this.W.length; l++) {
			const nIn = this.sizes[l], nOut = this.sizes[l + 1], W = this.W[l], b = this.b[l];
			const z = new Float64Array(nOut);
			for (let j = 0; j < nOut; j++) {
				let s = b[j];
				const off = j * nIn;
				for (let i = 0; i < nIn; i++) s += W[off + i] * a[i];
				z[j] = l < this.W.length - 1 ? Math.tanh(s) : s;
			}
			a = z;
			if (cache) cache.acts.push(a);
		}
		return a;
	}
	// Accumulates gradients into grads given dL/dout for one sample whose forward cache is given.
	backward(cache, dOut, grads) {
		let delta = dOut;
		for (let l = this.W.length - 1; l >= 0; l--) {
			const nIn = this.sizes[l], nOut = this.sizes[l + 1], W = this.W[l];
			const aIn = cache.acts[l], aOut = cache.acts[l + 1];
			if (l < this.W.length - 1) { // tanh'
				const d = new Float64Array(nOut);
				for (let j = 0; j < nOut; j++) d[j] = delta[j] * (1 - aOut[j] * aOut[j]);
				delta = d;
			}
			const gW = grads.W[l], gb = grads.b[l];
			const dIn = new Float64Array(nIn);
			for (let j = 0; j < nOut; j++) {
				const dj = delta[j];
				if (dj === 0) continue;
				gb[j] += dj;
				const off = j * nIn;
				for (let i = 0; i < nIn; i++) { gW[off + i] += dj * aIn[i]; dIn[i] += dj * W[off + i]; }
			}
			delta = dIn;
		}
	}
	zeroGrads() { return {W: this.W.map(w => new Float64Array(w.length)), b: this.b.map(b => new Float64Array(b.length))}; }
	toJSON() { return {sizes: this.sizes, W: this.W.map(w => Array.from(w)), b: this.b.map(b => Array.from(b))}; }
	static fromJSON(j) {
		const m = new MLP(j.sizes, () => 0.5);
		m.W = j.W.map(w => Float64Array.from(w)); m.b = j.b.map(b => Float64Array.from(b));
		return m;
	}
}

class Adam {
	constructor(net, lr = 1e-3, b1 = 0.9, b2 = 0.999, eps = 1e-8) {
		Object.assign(this, {net, lr, b1, b2, eps, t: 0});
		this.m = net.zeroGrads(); this.v = net.zeroGrads();
	}
	step(grads, scale = 1, clip = 1.0) {
		// global-norm gradient clipping
		let norm = 0;
		for (const arr of [...grads.W, ...grads.b]) for (let i = 0; i < arr.length; i++) norm += (arr[i] * scale) ** 2;
		norm = Math.sqrt(norm);
		const k = norm > clip ? clip / norm : 1;
		this.t++;
		const {b1, b2, eps, lr} = this;
		const c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
		const upd = (p, g, m, v) => {
			for (let i = 0; i < p.length; i++) {
				const gi = g[i] * scale * k;
				m[i] = b1 * m[i] + (1 - b1) * gi;
				v[i] = b2 * v[i] + (1 - b2) * gi * gi;
				p[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + eps);
			}
		};
		for (let l = 0; l < this.net.W.length; l++) {
			upd(this.net.W[l], grads.W[l], this.m.W[l], this.v.W[l]);
			upd(this.net.b[l], grads.b[l], this.m.b[l], this.v.b[l]);
		}
		return norm;
	}
}

module.exports = {MLP, Adam};
