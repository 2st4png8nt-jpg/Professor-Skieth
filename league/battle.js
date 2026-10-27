// Runs one battle in the Showdown engine between two bots and extracts stats.
const {Battle} = require('pokemon-showdown');
const {decide} = require('./ai');

function runBattle({format, seed, p1, p2, maxTurns = 300}) {
	const battle = new Battle({formatid: format, seed});
	battle.setPlayer('p1', {name: p1.name, team: p1.team});
	battle.setPlayer('p2', {name: p2.name, team: p2.team});
	const bots = {p1: p1.bot, p2: p2.bot};
	let guard = 0, errors = 0;
	while (!battle.ended && battle.turn <= maxTurns && guard++ < 5000) {
		for (const side of battle.sides) {
			const req = side.activeRequest;
			if (!req || req.wait || battle.ended) continue;
			let choice = 'default';
			try { choice = typeof bots[side.id] === 'function' ? bots[side.id](battle, side) : decide(bots[side.id], battle, side); } catch (e) { errors++; }
			let ok = false;
			try { ok = battle.choose(side.id, choice); } catch (e) { ok = false; }
			if (!ok) { errors++; try { battle.choose(side.id, 'default'); } catch (e) {} }
		}
	}
	if (!battle.ended) battle.tie();
	return {battle, errors, ...summarize(battle, p1, p2)};
}

// Public (spectator) log: drop the omniscient half of |split| pairs.
function publicLog(lines) {
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith('|split|')) { out.push(lines[i + 2]); i += 2; continue; }
		out.push(lines[i]);
	}
	return out;
}

function summarize(battle, p1, p2) {
	const log = publicLog(battle.log);
	const st = {};
	for (const id of ['p1', 'p2']) st[id] = {
		kos: 0, damagePct: 0, switches: 0, crits: 0, statusInflicted: 0, hazardsSet: 0,
		tera: null, moves: {}, superEffective: 0, missed: 0,
	};
	const hp = {};
	const foe = s => (s === 'p1' ? 'p2' : 'p1');
	for (const line of log) {
		const parts = line.split('|');
		const tag = parts[1];
		const who = parts[2] ? parts[2].slice(0, 2) : null;
		if (tag === 'move') st[who].moves[parts[3]] = (st[who].moves[parts[3]] || 0) + 1;
		else if (tag === 'switch' || tag === 'drag') {
			if (tag === 'switch') st[who].switches++;
			const [cur] = parts[4].split(' '); hp[parts[2]] = parseInt(cur);
		}
		else if (tag === '-damage' || tag === '-heal') {
			const cur = parts[3] === '0 fnt' ? 0 : parseInt(parts[3].split('/')[0]);
			const prev = hp[parts[2]] ?? 100;
			if (tag === '-damage' && prev > cur) st[foe(who)].damagePct += prev - cur;
			hp[parts[2]] = cur;
		}
		else if (tag === 'faint') st[foe(who)].kos++;
		else if (tag === '-crit') st[foe(who)].crits++;
		else if (tag === '-supereffective') st[foe(who)].superEffective++;
		else if (tag === '-miss') st[who].missed++;
		else if (tag === '-status') st[foe(who)].statusInflicted++;
		else if (tag === '-sidestart') st[foe(who)].hazardsSet++;
		else if (tag === '-terastallize') st[who].tera = `${parts[2].split(': ')[1]} → ${parts[3]}`;
	}
	const team = side => side.pokemon.map(p => ({
		species: p.species.name, level: p.level, item: p.item, ability: p.ability,
		tera: p.teraType, moves: p.moveSlots.map(m => m.move), fainted: p.fainted,
		hpLeft: Math.round(100 * p.hp / p.maxhp),
	}));
	const winner = battle.winner === p1.name ? 'p1' : battle.winner === p2.name ? 'p2' : null;
	return {
		winner, winnerName: battle.winner || null, turns: battle.turn,
		p1: {name: p1.name, remaining: battle.sides[0].pokemon.filter(p => !p.fainted).length, team: team(battle.sides[0]), ...st.p1},
		p2: {name: p2.name, remaining: battle.sides[1].pokemon.filter(p => !p.fainted).length, team: team(battle.sides[1]), ...st.p2},
		publicLog: log,
		inputLog: battle.inputLog,
	};
}

function replayHtml(title, log) {
	const safe = log.join('\n').replace(/<\//g, '<\\/');
	return `<!DOCTYPE html>
<meta charset="utf-8" />
<!-- version 1 -->
<title>${title}</title>
<style>html,body{font-family:Verdana,sans-serif;font-size:10pt;margin:0;padding:0}body{padding:12px 0}.battle-log{font-family:Verdana,sans-serif;font-size:10pt}#loading-message{text-align:center}</style>
<div class="wrapper replay-wrapper" style="max-width:1180px;margin:0 auto">
<input type="hidden" name="replayid" value="${title.replace(/\W+/g, '-').toLowerCase()}" />
<div class="battle"></div><div class="battle-log"></div><div class="replay-controls"></div><div class="replay-controls-2"></div>
<h1 style="font-weight:normal;text-align:center"><strong>${title}</strong></h1>
<script type="text/plain" class="battle-log-data">${safe}
</script>
</div>
<div class="battle-log battle-log-inline"><div class="inner"></div></div>
<script>
let daily = Math.floor(Date.now()/1000/60/60/24);document.write('<script src="https://play.pokemonshowdown.com/js/replay-embed.js?version'+daily+'"></'+'script>');
</script>
`;
}

module.exports = {runBattle, replayHtml};
