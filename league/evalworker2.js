// Worker: plays sample runs (fixed team, varying battle luck) and reports results.
const {parentPort} = require('worker_threads');
const {Teams} = require('pokemon-showdown');
const {playRun} = require('./runner');

parentPort.on('message', ({id, mode, genome, teamText, stages, seeds, champGenome}) => {
	const team = Teams.import(teamText);
	let total = 0;
	if (mode === 'chal') {
		// Challenger fitness: average depth reached (0–9).
		for (const sd of seeds) total += playRun({genome, chalName: 'C', team, stages, battleSeed: sd}).depth;
	} else {
		// Champion fitness: share of champion series it defends.
		const last = stages[stages.length - 1];
		for (const sd of seeds) total += playRun({genome, chalName: 'C', team, stages: [{...last, genome: champGenome}], battleSeed: sd}).depth === 0 ? 1 : 0;
	}
	parentPort.postMessage({id, total, n: seeds.length});
});
