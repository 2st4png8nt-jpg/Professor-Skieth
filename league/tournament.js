// Phase 1: 14-bot round robin, best of 3, Gen 9 Random Battle.
// Game 2 replays game 1's teams with sides swapped so team luck cancels out.
const fs = require('fs');
const path = require('path');
const {runBattle, replayHtml} = require('./battle');
const {BOTS} = require('./ai');

const OUT = path.join(__dirname, 'output');
for (const d of ['data', 'replays', 'logs']) fs.mkdirSync(path.join(OUT, d), {recursive: true});
const FORMAT = 'gen9randombattle';
const names = Object.keys(BOTS);
const games = [], series = [];
const elo = Object.fromEntries(names.map(n => [n, 1500]));
const table = Object.fromEntries(names.map(n => [n, {
	name: n, style: BOTS[n].style, seriesW: 0, seriesL: 0, gameW: 0, gameL: 0,
	kos: 0, kosAgainst: 0, damagePct: 0, turns: 0, crits: 0, statusInflicted: 0, hazardsSet: 0, teraWins: 0, h2h: {},
}]));

function record(id, round, a, b, r, phase) {
	const p1 = r.p1.name, p2 = r.p2.name;
	const row = {id, phase, format: FORMAT, round, p1, p2, winner: r.winnerName, turns: r.turns,
		p1_remaining: r.p1.remaining, p2_remaining: r.p2.remaining, p1_stats: strip(r.p1), p2_stats: strip(r.p2)};
	games.push(row);
	fs.writeFileSync(path.join(OUT, 'logs', `${id}.log`), r.publicLog.join('\n'));
	fs.writeFileSync(path.join(OUT, 'logs', `${id}.input.log`), r.inputLog.join('\n'));
	fs.writeFileSync(path.join(OUT, 'replays', `${id}.html`), replayHtml(`${p1} vs. ${p2} — ${id}`, r.publicLog));
	for (const [me, s, o] of [[p1, r.p1, r.p2], [p2, r.p2, r.p1]]) {
		const t = table[me];
		t.kos += s.kos; t.kosAgainst += o.kos; t.damagePct += s.damagePct; t.turns += r.turns;
		t.crits += s.crits; t.statusInflicted += s.statusInflicted; t.hazardsSet += s.hazardsSet;
		if (r.winnerName === me) { t.gameW++; if (s.tera) t.teraWins++; } else t.gameL++;
	}
	if (r.winnerName) {
		const w = r.winnerName, l = w === p1 ? p2 : p1;
		const ew = 1 / (1 + Math.pow(10, (elo[l] - elo[w]) / 400));
		elo[w] += 32 * (1 - ew); elo[l] -= 32 * (1 - ew);
	}
}
const strip = s => ({remaining: s.remaining, kos: s.kos, damagePct: s.damagePct, switches: s.switches, crits: s.crits,
	statusInflicted: s.statusInflicted, hazardsSet: s.hazardsSet, tera: s.tera, superEffective: s.superEffective,
	missed: s.missed, moves: s.moves, team: s.team});

let round = 0, pairIdx = 0;
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
	const a = names[i], b = names[j]; pairIdx++; round++;
	let wa = 0, wb = 0, g = 0;
	const seedA = [pairIdx, 1, 2026, 77], seedB = [pairIdx, 3, 2026, 91];
	while (wa < 2 && wb < 2 && g < 5) {
		g++;
		const sw = g === 2; // mirror: same seed, sides swapped
		const seed = g <= 2 ? seedA : g === 3 ? seedB : [pairIdx, g, 7, 7];
		const P = sw ? {name: b, bot: b} : {name: a, bot: a};
		const Q = sw ? {name: a, bot: a} : {name: b, bot: b};
		const r = runBattle({format: FORMAT, seed, p1: P, p2: Q});
		record(`rr-${String(pairIdx).padStart(2, '0')}-g${g}`, round, a, b, r, 'round-robin');
		if (r.winnerName === a) wa++; else if (r.winnerName === b) wb++;
	}
	const winner = wa > wb ? a : b, loser = winner === a ? b : a;
	table[winner].seriesW++; table[loser].seriesL++;
	table[winner].h2h[loser] = 'W'; table[loser].h2h[winner] = 'L';
	series.push({pair: pairIdx, a, b, score: `${wa}-${wb}`, winner});
	process.stdout.write(`${a} ${wa}-${wb} ${b}\n`);
}

const standings = Object.values(table).map(t => ({...t, elo: Math.round(elo[t.name]), koDiff: t.kos - t.kosAgainst}))
	.sort((x, y) => y.seriesW - x.seriesW || (y.gameW - y.gameL) - (x.gameW - x.gameL) || y.koDiff - x.koDiff || y.elo - x.elo);
standings.forEach((s, i) => { s.rank = i + 1; });

fs.writeFileSync(path.join(OUT, 'data', 'battles.jsonl'), games.map(g => JSON.stringify(g)).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'data', 'series.json'), JSON.stringify(series, null, 1));
fs.writeFileSync(path.join(OUT, 'data', 'standings.json'), JSON.stringify(standings, null, 1));
console.log('\nSTANDINGS');
for (const s of standings) console.log(`${s.rank}. ${s.name.padEnd(7)} ${s.style.padEnd(16)} series ${s.seriesW}-${s.seriesL} games ${s.gameW}-${s.gameL} KO+/- ${s.koDiff} elo ${s.elo}`);
console.log('games', games.length);
