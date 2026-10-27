// Phase 2: top 8 become gym leaders with fixed Gen 9 Monotype teams, then battle each other (best of 3).
const fs = require('fs');
const path = require('path');
const {Teams} = require('pokemon-showdown');
const {runBattle, replayHtml} = require('./battle');
const {BOTS} = require('./ai');
const GYM = require('./gym_teams');

const OUT = path.join(__dirname, 'output');
const FORMAT = 'gen9monotype';
const standings = JSON.parse(fs.readFileSync(path.join(OUT, 'data', 'standings.json')));
const top8 = standings.slice(0, 8).map(s => s.name);
fs.mkdirSync(path.join(OUT, 'gym-teams'), {recursive: true});

const leaders = top8.map((n, i) => {
	const g = GYM[n];
	const name = `${n} (${g.type})`;
	fs.writeFileSync(path.join(OUT, 'gym-teams', `${i + 1}-${n}-${g.type}.txt`), g.team.trim() + '\n');
	return {agent: n, name, type: g.type, title: g.title, reason: g.reason, style: BOTS[n].style,
		seed: i + 1, team: Teams.pack(Teams.import(g.team)), paste: g.team.trim(),
		roster: Teams.import(g.team).map(p => p.species), W: 0, L: 0, gW: 0, gL: 0, kos: 0, kosAgainst: 0, h2h: {}};
});
const games = [], series = [];
let k = 0;
for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
	const A = leaders[i], B = leaders[j]; k++;
	let wa = 0, wb = 0, g = 0;
	while (wa < 2 && wb < 2 && g < 5) {
		g++;
		const [X, Y] = g % 2 === 0 ? [B, A] : [A, B];
		const r = runBattle({format: FORMAT, seed: [k, g, 99, 2026],
			p1: {name: X.name, bot: X.agent, team: X.team}, p2: {name: Y.name, bot: Y.agent, team: Y.team}});
		const id = `gym-${String(k).padStart(2, '0')}-g${g}`;
		fs.writeFileSync(path.join(OUT, 'logs', `${id}.log`), r.publicLog.join('\n'));
		fs.writeFileSync(path.join(OUT, 'logs', `${id}.input.log`), r.inputLog.join('\n'));
		fs.writeFileSync(path.join(OUT, 'replays', `${id}.html`), replayHtml(`Gym Battle: ${X.name} vs. ${Y.name}`, r.publicLog));
		const strip = s => ({remaining: s.remaining, kos: s.kos, damagePct: s.damagePct, switches: s.switches, crits: s.crits,
			statusInflicted: s.statusInflicted, hazardsSet: s.hazardsSet, tera: s.tera, superEffective: s.superEffective,
			missed: s.missed, moves: s.moves, team: s.team});
		games.push({id, phase: 'gym-league', format: FORMAT, round: k, p1: X.name, p2: Y.name, winner: r.winnerName,
			turns: r.turns, p1_remaining: r.p1.remaining, p2_remaining: r.p2.remaining, p1_stats: strip(r.p1), p2_stats: strip(r.p2)});
		for (const [L, s, o] of [[X, r.p1, r.p2], [Y, r.p2, r.p1]]) {
			L.kos += s.kos; L.kosAgainst += o.kos;
			if (r.winnerName === L.name) L.gW++; else L.gL++;
		}
		if (r.winnerName === A.name) wa++; else if (r.winnerName === B.name) wb++;
	}
	const W = wa > wb ? A : B, Lo = W === A ? B : A;
	W.W++; Lo.L++; W.h2h[Lo.agent] = 'W'; Lo.h2h[W.agent] = 'L';
	series.push({a: A.name, b: B.name, score: `${wa}-${wb}`, winner: W.name});
	console.log(`${A.name} ${wa}-${wb} ${B.name}`);
}
const ranked = leaders.slice().sort((x, y) => y.W - x.W || (y.gW - y.gL) - (x.gW - x.gL) || (y.kos - y.kosAgainst) - (x.kos - x.kosAgainst));
ranked.forEach((l, i) => { l.gymRank = i + 1; });
fs.writeFileSync(path.join(OUT, 'data', 'gym_battles.jsonl'), games.map(g => JSON.stringify(g)).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'data', 'gym_series.json'), JSON.stringify(series, null, 1));
fs.writeFileSync(path.join(OUT, 'data', 'gym_leaders.json'), JSON.stringify(ranked.map(({team, ...l}) => l), null, 1));
console.log('\nGYM LEAGUE');
for (const l of ranked) console.log(`${l.gymRank}. ${l.name.padEnd(18)} ${l.W}-${l.L} games ${l.gW}-${l.gL}`);
console.log('games', games.length);
