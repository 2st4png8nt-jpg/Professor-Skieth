// The Gauntlet, v2 rules:
// - Gym leaders are FIXED (same brain + team every time).
// - Every run starts at Gym 1; one lost series sends the challenger back to Gym 1.
// - The challenger must clear Gym 1 → 8 in one run, then the Champion.
// - Challenger learns after every failed run: (1) team: keeps the Pokémon that performed, redraws the
//   two weakest from random-battle sets; (2) brain: tests mutated strategies on sample runs and keeps one
//   only if it also wins on a fresh validation set.
// - The Champion learns after every title defense.
// - Every real battle is saved for the replay site.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {Worker} = require('worker_threads');
const {Teams, Dex} = require('pokemon-showdown');
const {brain, seedGenome, mutate, average, LABELS} = require('./brain');
const {GYM_ORDER, randomTeam, playRun} = require('./runner');
const GYM = require('./gym_teams');

const OUT = path.join(__dirname, 'output', 'gauntlet2');
fs.mkdirSync(path.join(OUT, 'runs'), {recursive: true});
const MAX_RUNS = 2000, MAX_SECONDS = 112 * 60;
const CH_MUTANTS = 4, CH_SAMPLES = 6, CHAMP_MUTANTS = 4, CHAMP_SAMPLES = 10;

let s0 = 777;
const rng = () => { s0 |= 0; s0 = s0 + 0x6D2B79F5 | 0; let t = Math.imul(s0 ^ s0 >>> 15, 1 | s0); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const seed4 = () => [1, 2, 3, 4].map(() => 1 + Math.floor(rng() * 60000));

// ----- Workers -----
const N = 2;
const workers = Array.from({length: N}, () => new Worker(path.join(__dirname, 'evalworker2.js')));
const pending = new Map(); let jid = 0, rr = 0;
workers.forEach(w => w.on('message', m => { pending.get(m.id)(m); pending.delete(m.id); }));
const job = msg => new Promise(res => { const id = ++jid; pending.set(id, res); workers[rr++ % N].postMessage({id, ...msg}); });
async function score(msg, seeds) {
	const h = Math.ceil(seeds.length / 2);
	const rs = await Promise.all([job({...msg, seeds: seeds.slice(0, h)}), job({...msg, seeds: seeds.slice(h)})]);
	return rs.reduce((a, r) => a + r.total, 0) / seeds.length;
}
async function evolve(current, mutants, samples, fit) {
	const A = Array.from({length: samples}, seed4);
	const ra = []; for (const g of [current, ...mutants]) ra.push(await fit(g, A));
	let bi = 1; for (let i = 1; i < ra.length; i++) if (ra[i] > ra[bi]) bi = i;
	if (ra[bi] <= ra[0]) return {improved: false, genome: current, before: ra[0], after: ra[0]};
	const B = Array.from({length: samples}, seed4);
	const cb = await fit(current, B), mb = await fit(mutants[bi - 1], B);
	return mb > cb ? {improved: true, genome: mutants[bi - 1], before: (ra[0] + cb) / 2, after: (ra[bi] + mb) / 2}
		: {improved: false, genome: current, before: (ra[0] + cb) / 2, after: (ra[0] + cb) / 2};
}

// ----- League -----
const gyms = GYM_ORDER.map((k, i) => ({key: k, badge: i + 1, type: GYM[k].type, name: `Gym Leader ${k} (${GYM[k].type})`,
	team: Teams.pack(Teams.import(GYM[k].team)), genome: seedGenome(k)}));
const ACES = {Sage: 'Dragonite', Ace: 'Primarina', Cairn: 'Tyranitar', Dash: 'Raging Bolt', Hawk: 'Landorus-Therian', Oracle: 'Latios'};
const allStar = Object.entries(ACES).map(([g, sp]) => Teams.import(GYM[g].team).find(p => p.species === sp));
const champ = {key: 'Champion', badge: 9, type: 'All-Star', name: 'Champion Nexus v1', version: 1,
	team: Teams.pack(allStar), genome: average(GYM_ORDER.map(seedGenome))};
const stagesFor = () => [...gyms, {...champ, name: `Champion Nexus v${champ.version}`}];
const stageLite = () => stagesFor().map(s => ({key: s.key, name: s.name, team: s.team, genome: s.genome}));

const chal = {name: 'Volt', genome: seedGenome('Volt'), version: 1};
let roster = randomTeam(seed4()).map(p => ({set: p, joined: 1}));

// Per-Pokémon performance from a public log, for the challenger's side.
function credit(log, side, perf) {
	const foe = side === 'p1' ? 'p2' : 'p1';
	const active = {}; const hp = {};
	for (const line of log) {
		const p = line.split('|'); const tag = p[1];
		if (tag === 'switch' || tag === 'drag') {
			const who = p[2].slice(0, 2), nick = p[2].split(': ')[1];
			active[who] = nick; hp[who] = parseInt(p[4]);
			if (who === side) { perf[nick] = perf[nick] || {dmg: 0, kos: 0, games: 0, seen: new Set()}; perf[nick].seen.add('x'); }
		} else if (tag === '-damage' && p[2].startsWith(foe)) {
			const cur = p[3] === '0 fnt' ? 0 : parseInt(p[3]); const prev = hp[foe] ?? 100;
			if (prev > cur && active[side] && perf[active[side]]) perf[active[side]].dmg += prev - cur;
			hp[foe] = cur;
		} else if (tag === '-heal' && p[2].startsWith(foe)) hp[foe] = parseInt(p[3]);
		else if (tag === 'faint' && p[2].startsWith(foe) && active[side] && perf[active[side]]) perf[active[side]].kos++;
	}
	for (const k of Object.keys(perf)) if (perf[k].seen.size) { perf[k].games++; perf[k].seen.clear(); }
}

function publicLog(lines) {
	const out = [];
	for (let i = 0; i < lines.length; i++) { if (lines[i].startsWith('|split|')) { out.push(lines[i + 2]); i += 2; } else out.push(lines[i]); }
	return out;
}

const runsIndex = [], brainHistory = [{version: 1, genome: {...chal.genome}, afterRun: 0}], champHistory = [{version: 1, genome: {...champ.genome}, afterRun: 0}];
let championRun = null, best = 0;
const t0 = Date.now();

(async () => {
	for (let run = 1; run <= MAX_RUNS && (Date.now() - t0) / 1000 < MAX_SECONDS; run++) {
		const team = roster.map(r => r.set);
		const games = []; const perf = {};
		const stages = stagesFor();
		const res = playRun({genome: chal.genome, chalName: `Volt v${chal.version}`, team, stages, battleSeed: seed4(),
			onGame: (si, g, r, swap, won) => {
				const log = publicLog(r.battle.log);
				credit(log, swap ? 'p2' : 'p1', perf);
				games.push({stage: stages[si].key, stageName: stages[si].name, badge: si + 1, game: g, won, turns: r.turns,
					p1: r.p1.name, p2: r.p2.name, winner: r.winnerName, log: log.join('\n')});
			}});
		best = Math.max(best, res.depth);
		const rec = {run, brainVersion: chal.version, champVersion: champ.version, depth: res.depth, champion: res.champion,
			reached: res.depth >= 8 ? 'Champion' : stages[res.depth].key,
			series: res.series, team: roster.map(r => ({species: r.set.species, joined: r.joined, ...(perf[r.set.name || r.set.species] ? {
				dmg: perf[r.set.name || r.set.species].dmg, kos: perf[r.set.name || r.set.species].kos} : {dmg: 0, kos: 0})})),
			teamText: Teams.export(team), games: games.length};
		fs.writeFileSync(path.join(OUT, 'runs', `run-${String(run).padStart(4, '0')}.json.gz`),
			zlib.gzipSync(JSON.stringify({...rec, games})));
		const line = `Run ${run}: Volt v${chal.version} → ${res.champion ? 'BECAME CHAMPION' : res.depth === 8 ? 'lost to the Champion' : `lost at Gym ${res.depth + 1} (${stages[res.depth].key})`} | best ${best} | ${((Date.now() - t0) / 60000).toFixed(1)} min`;
		console.log(line);
		if (res.champion) { championRun = rec; runsIndex.push(rec); break; }

		// Champion defends → learns.
		if (res.depth === 8) {
			const teamText = Teams.export(team);
			const ev = await evolve(champ.genome, Array.from({length: CHAMP_MUTANTS}, () => mutate(champ.genome, rng, 0.15)), CHAMP_SAMPLES,
				(g, seeds) => score({mode: 'champ', genome: chal.genome, teamText, stages: stageLite(), champGenome: g}, seeds));
			if (ev.improved) { champ.genome = ev.genome; champ.version++; champHistory.push({version: champ.version, genome: {...ev.genome}, afterRun: run}); }
			rec.champLearned = ev.improved;
		}

		// Challenger learns 1: team. Keep performers, redraw the two weakest.
		const rated = roster.map(r => {
			const p = perf[r.set.name || r.set.species];
			const v = p && p.games ? (p.dmg + 60 * p.kos) / p.games : null;
			return {r, v};
		});
		const known = rated.filter(x => x.v !== null).map(x => x.v).sort((a, b) => a - b);
		const median = known.length ? known[Math.floor(known.length / 2)] : 0;
		rated.forEach(x => { if (x.v === null) x.v = median * 0.8; });
		rated.sort((a, b) => a.v - b.v);
		const drop = rated.slice(0, 2).map(x => x.r);
		const keep = roster.filter(r => !drop.includes(r));
		const have = new Set(keep.map(r => Dex.species.get(r.set.species).baseSpecies));
		const fresh = [];
		while (fresh.length < drop.length) {
			for (const p of randomTeam(seed4())) {
				const b = Dex.species.get(p.species).baseSpecies;
				if (!have.has(b) && fresh.length < drop.length) { have.add(b); fresh.push({set: p, joined: run + 1}); }
			}
		}
		roster = [...keep, ...fresh];
		rec.dropped = drop.map(r => r.set.species); rec.added = fresh.map(r => r.set.species);

		// Challenger learns 2: brain, trained on the new team.
		const teamText = Teams.export(roster.map(r => r.set));
		const scale = 0.15;
		const ev = await evolve(chal.genome, Array.from({length: CH_MUTANTS}, () => mutate(chal.genome, rng, scale)), CH_SAMPLES,
			(g, seeds) => score({mode: 'chal', genome: g, teamText, stages: stageLite()}, seeds));
		if (ev.improved) { chal.genome = ev.genome; chal.version++; brainHistory.push({version: chal.version, genome: {...ev.genome}, afterRun: run, before: ev.before, after: ev.after}); }
		rec.brainLearned = ev.improved;
		runsIndex.push(rec);
		fs.writeFileSync(path.join(OUT, 'progress.json'), JSON.stringify({run, best, version: chal.version, champVersion: champ.version, minutes: (Date.now() - t0) / 60000}));
	}
	const summary = {
		rules: 'Fixed gyms; every run starts at Gym 1; one lost best-of-3 series ends the run; challenger keeps strong Pokémon and redraws the 2 weakest after each failed run; challenger brain and Champion brain learn with validated mutations.',
		championRun, totalRuns: runsIndex.length, best, labels: LABELS,
		gyms: gyms.map(g => ({badge: g.badge, key: g.key, type: g.type, teamText: GYM[g.key].team.trim()})),
		champion: {name: 'Champion Nexus', finalVersion: champ.version, teamText: Teams.export(allStar)},
		brainHistory, champHistory, runs: runsIndex, minutes: (Date.now() - t0) / 60000,
	};
	fs.writeFileSync(path.join(OUT, 'gauntlet.json'), JSON.stringify(summary, null, 1));
	console.log(championRun ? `\nCHAMPION: Volt v${championRun.brainVersion} on run ${championRun.run}` : `\nNo champion yet after ${runsIndex.length} runs (best depth ${best})`);
	workers.forEach(w => w.terminate());
})();
