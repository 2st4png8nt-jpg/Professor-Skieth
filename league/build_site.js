// Builds the replay site data into the repo's docs/ folder.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = process.argv[2] || '/home/claude/professor-skieth';
const DOCS = path.join(REPO, 'docs');
const G2 = path.join(__dirname, 'output', 'gauntlet2');
for (const d of ['data', 'runs', 'league']) fs.mkdirSync(path.join(DOCS, d), {recursive: true});

// Gauntlet runs
const files = fs.existsSync(path.join(G2, 'runs')) ? fs.readdirSync(path.join(G2, 'runs')).filter(f => f.endsWith('.json.gz')).sort() : [];
const runs = [];
for (const f of files) {
	const buf = fs.readFileSync(path.join(G2, 'runs', f));
	const r = JSON.parse(zlib.gunzipSync(buf));
	fs.writeFileSync(path.join(DOCS, 'runs', f), buf);
	runs.push({run: r.run, brainVersion: r.brainVersion, champVersion: r.champVersion, depth: r.depth, champion: r.champion,
		reached: r.reached, series: r.series, team: r.team.map(t => t.species), games: r.games});
}
const progress = fs.existsSync(path.join(G2, 'progress.json')) ? JSON.parse(fs.readFileSync(path.join(G2, 'progress.json'))) : null;
const final = fs.existsSync(path.join(G2, 'gauntlet.json')) ? JSON.parse(fs.readFileSync(path.join(G2, 'gauntlet.json'))) : null;
const GYM = require('./gym_teams');
const {GYM_ORDER} = require('./runner');
const status = {
	updated: new Date().toISOString(), finished: !!final, progress,
	champion: final && final.championRun ? {run: final.championRun.run, version: final.championRun.brainVersion, team: final.championRun.team, teamText: final.championRun.teamText} : null,
	brainHistory: final ? final.brainHistory : null, champHistory: final ? final.champHistory : null, labels: final ? final.labels : null,
	gyms: GYM_ORDER.map((k, i) => ({badge: i + 1, leader: k, type: GYM[k].type, title: GYM[k].title, team: GYM[k].team.trim()})),
	championTeam: final ? final.champion.teamText : null,
};
fs.writeFileSync(path.join(DOCS, 'data', 'runs.json'), JSON.stringify(runs));
fs.writeFileSync(path.join(DOCS, 'data', 'status.json'), JSON.stringify(status));

// Phase 1 + gym league battles
const out = path.join(__dirname, 'output');
const league = [];
for (const f of ['battles.jsonl', 'gym_battles.jsonl']) {
	for (const line of fs.readFileSync(path.join(out, 'data', f), 'utf8').split('\n').filter(Boolean)) {
		const g = JSON.parse(line);
		const log = fs.readFileSync(path.join(out, 'logs', `${g.id}.log`));
		fs.writeFileSync(path.join(DOCS, 'league', `${g.id}.log.gz`), zlib.gzipSync(log));
		league.push({id: g.id, phase: g.phase, p1: g.p1, p2: g.p2, winner: g.winner, turns: g.turns});
	}
}
fs.writeFileSync(path.join(DOCS, 'data', 'league.json'), JSON.stringify(league));
fs.copyFileSync(path.join(out, 'data', 'standings.json'), path.join(DOCS, 'data', 'standings.json'));
console.log(`site data: ${runs.length} runs, ${league.length} league battles`);
