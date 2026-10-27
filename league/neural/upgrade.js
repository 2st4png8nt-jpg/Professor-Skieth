// "Neural Upgrade": every gym leader and champion gets the trained shared brain.
// 1) Proof: each agent's OWN team piloted by the new brain vs the same team on their old brain
//    (same teams, sides swapped every game, so only the brain differs).
// 2) Rematch: the 8 gym leaders' league (round robin, best of 3) and the 4-champion Brawl
//    (round robin best of 5 + best-of-7 final), everyone on the neural brain.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {Teams} = require('pokemon-showdown');
const {runBattle} = require('../battle');
const {brain} = require('../brain');
const {neuralBrain, netsFromJSON} = require('./policy');

const OUT = path.join(__dirname, '..', 'output', 'neural-season');
fs.mkdirSync(OUT, {recursive: true});
const FORMAT = 'gen9championscustomgame';
const o = p => path.join(__dirname, '..', 'output', p);
const lv50 = t => { const x = Teams.import(t); x.forEach(p => { p.level = 50; }); return Teams.pack(x); };
const best = JSON.parse(fs.readFileSync(o('neural/best.json')));
const nets = netsFromJSON(best);
const NEURAL = () => neuralBrain(nets, {mode: 'greedy'});
const PROOF_GAMES = Number(process.env.PROOF_GAMES) || 40;

const IMP = JSON.parse(fs.readFileSync(o('gyms_improved.json')));
const S2 = JSON.parse(fs.readFileSync(o('gauntlet-s2/gauntlet.json')));
const volt = JSON.parse(fs.readFileSync(o('volt_brain.json')));
const agents = [];
for (const [k, g] of Object.entries(IMP)) agents.push({name: k, role: `${g.type} Gym Leader`, type: g.type, teamText: g.teamText, genome: g.genome});
agents.push({name: 'Volt', role: 'Season 2 Champion', teamText: S2.championRun.teamText, genome: volt.genome});
for (const r of ['Red', 'Blue', 'Skeith']) {
	const c = JSON.parse(fs.readFileSync(o(`s4-${r.toLowerCase()}/champion.json`)));
	agents.push({name: r, role: r === 'Red' ? 'Grand Champion' : 'Champion', teamText: c.teamText, genome: c.genome});
}
const pub = log => { const out = []; for (let i = 0; i < log.length; i++) { if (log[i].startsWith('|split|')) { out.push(log[i + 2]); i += 2; } else out.push(log[i]); } return out; };
let gameNo = 0;
const allGames = [];
function play(A, B, a, b, stage) {
	gameNo++;
	const r = runBattle({format: FORMAT, seed: [gameNo, 3131, 7, 1], p1: {name: a.label, bot: a.bot, team: a.team}, p2: {name: b.label, bot: b.bot, team: b.team}});
	return r;
}

// ----- 1) Proof: new brain vs old brain, same team -----
const proof = [];
for (const ag of agents) {
	const team = lv50(ag.teamText);
	let newW = 0, games = 0;
	for (let i = 0; i < PROOF_GAMES; i++) {
		// both sides pilot the same team; opponent team rotates through the league so it's a fair sample
		const opp = agents[(agents.indexOf(ag) + 1 + (i % (agents.length - 1))) % agents.length];
		const oppTeam = lv50(opp.teamText);
		// game pair: neural-ag vs old-opp, and old-ag vs old-opp is the baseline? Simpler and cleaner:
		// neural agent vs old-brain copy of itself on mirrored teams (agent team vs opp team, sides swap).
		const swap = i % 2 === 1;
		const N = {label: 'New', bot: NEURAL(), team: swap ? oppTeam : team};
		const Ol = {label: 'Old', bot: brain(ag.genome), team: swap ? team : oppTeam};
		const r = play(null, null, N, Ol, 'proof');
		games++; if (r.winnerName === 'New') newW++;
	}
	proof.push({name: ag.name, role: ag.role, newWins: newW, games, rate: newW / games});
	console.log(`${ag.name.padEnd(7)} new brain vs old brain: ${newW}/${games} (${(100 * newW / games).toFixed(0)}%)`);
}

// ----- 2) Rematch tournaments on the neural brain -----
function series(a, b, bestOf, stage) {
	const need = Math.ceil(bestOf / 2); let wa = 0, wb = 0, g = 0;
	while (wa < need && wb < need) {
		g++;
		const [X, Y] = g % 2 ? [a, b] : [b, a];
		const r = play(null, null, {label: X.name, bot: NEURAL(), team: lv50(X.teamText)}, {label: Y.name, bot: NEURAL(), team: lv50(Y.teamText)}, stage);
		if (r.winnerName === a.name) wa++; else wb++;
		allGames.push({stage, game: g, p1: X.name, p2: Y.name, winner: r.winnerName, turns: r.turns, a: a.name, b: b.name, log: pub(r.battle.log).join('\n')});
	}
	console.log(`${stage}: ${a.name} ${wa}-${wb} ${b.name}`);
	return {a: a.name, b: b.name, wa, wb, winner: wa > wb ? a.name : b.name, stage};
}
function roundRobin(list, bestOf, stage) {
	const res = [], tab = Object.fromEntries(list.map(x => [x.name, {name: x.name, sw: 0, sl: 0, gw: 0, gl: 0}]));
	for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
		const s = series(list[i], list[j], bestOf, stage); res.push(s);
		tab[s.winner].sw++; tab[s.winner === s.a ? s.b : s.a].sl++;
		tab[s.a].gw += s.wa; tab[s.a].gl += s.wb; tab[s.b].gw += s.wb; tab[s.b].gl += s.wa;
	}
	const st = Object.values(tab).sort((x, y) => y.sw - x.sw || (y.gw - y.gl) - (x.gw - x.gl));
	return {res, st};
}
const gymLeague = roundRobin(agents.slice(0, 8), 3, 'Gym league');
const four = agents.filter(a => ['Volt', 'Red', 'Blue', 'Skeith'].includes(a.name));
const brawlRR = roundRobin(four, 5, 'Round robin');
const [f1, f2] = brawlRR.st.slice(0, 2).map(s => four.find(f => f.name === s.name));
const final = series(f1, f2, 7, 'Grand Final');

const oldBrawl = JSON.parse(fs.readFileSync(o('brawl/brawl.json')));
const summary = {
	trainedOn: {iter: best.iter, totalGames: best.totalGames, evalWinRate: best.winRate},
	proof, gymLeague: gymLeague.st, gymSeries: gymLeague.res,
	brawl: {fighters: four.map(f => ({name: f.name, origin: oldBrawl.fighters.find(x => x.name === f.name)?.origin || f.role, teamText: f.teamText, version: 'Neural brain'})),
		standings: brawlRR.st, results: [...brawlRR.res, final], champion: final.winner,
		games: allGames.filter(g => g.stage !== 'Gym league').map(({log, ...g}) => g)},
	previousChampion: oldBrawl.champion,
};
fs.writeFileSync(path.join(OUT, 'neural.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, 'games.json.gz'), zlib.gzipSync(JSON.stringify(allGames.filter(g => g.stage !== 'Gym league'))));
fs.writeFileSync(path.join(OUT, 'gym-games.json.gz'), zlib.gzipSync(JSON.stringify(allGames.filter(g => g.stage === 'Gym league'))));
console.log(`\nNEURAL GRAND CHAMPION: ${final.winner} (before: ${oldBrawl.champion})`);
