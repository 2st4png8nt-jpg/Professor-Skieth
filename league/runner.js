// Shared run logic for the gauntlet: a run = one random team, Gym 1 → Gym 8 → Champion, best of 3 each.
// Any lost series ends the run.
const {Teams} = require('pokemon-showdown');
const {runBattle} = require('./battle');
const {brain} = require('./brain');

const GYM_ORDER = ['Monk', 'Blaze', 'Oracle', 'Hawk', 'Dash', 'Cairn', 'Ace', 'Sage']; // weakest → strongest in the gym league

function randomTeam(seed) {
	const t = Teams.generate('gen9randombattle', {seed});
	t.forEach(p => { p.level = 100; });
	return t;
}

// stages: [{key, name, team(packed), genome}], last one is the Champion.
// onGame(stageIdx, gameNo, result, sides) is called for real runs so battles can be saved.
function playRun({genome, chalName, teamSeed, team: given, stages, battleSeed, onGame}) {
	const team = given || randomTeam(teamSeed);
	const packed = Teams.pack(team);
	let s = 0, n = 0;
	const series = [];
	for (; s < stages.length; s++) {
		const st = stages[s];
		let cw = 0, dw = 0, g = 0;
		while (cw < 2 && dw < 2) {
			g++; n++;
			const C = {name: chalName, bot: brain(genome), team: packed};
			const D = {name: st.name, bot: brain(st.genome), team: st.team};
			const swap = g === 2;
			const r = runBattle({format: 'gen9customgame', seed: [battleSeed[0], battleSeed[1] + n, battleSeed[2], 1 + s],
				p1: swap ? D : C, p2: swap ? C : D});
			const won = r.winnerName === C.name;
			if (won) cw++; else dw++;
			if (onGame) onGame(s, g, r, swap, won);
		}
		series.push({stage: st.key, score: `${cw}-${dw}`, won: cw === 2});
		if (dw === 2) break;
	}
	return {depth: s, team, series, champion: s === stages.length};
}

module.exports = {GYM_ORDER, randomTeam, playRun};
