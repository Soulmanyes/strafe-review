#!/usr/bin/env node
'use strict';
// Prints the compare page's summary stats (static/stats.js) for saved attempts, so the numbers can be
// checked against the jump strip and the drill page, and the key lag against the known replay lead.
// After the bar: the main page's run stats (band, swaps, key switch), the same summarize() call.
//
//   node viewer/check_stats.js [--store DIR] [id ...]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const data = require('./static/data.js');
Object.assign(globalThis, data);
Object.assign(globalThis, require('./static/checks.js'));
const { summarize } = require('./static/stats.js');

const args = process.argv.slice(2);
const at = args.indexOf('--store');
const store = at >= 0 ? args[at + 1] : path.join(process.env.HOME, '.local/share/strafe-review/attempts');
const only = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));

const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '-');
for (const m of fs.readdirSync(store)) {
	const dir = path.join(store, m);
	if (!fs.statSync(dir).isDirectory()) continue;
	for (const file of fs.readdirSync(dir).sort()) {
		if (!file.endsWith('.json.gz')) continue;
		const id = file.replace('.json.gz', '');
		if (only.length && !only.includes(id)) continue;
		const a = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, file))).toString());
		const d = data.parse(a);
		const { jumps } = data.findJumps(d, a.preRows);
		const s = summarize(a, d, jumps);
		const who = isOther(a) ? `${a.label} ${a.player}` : 'own';
		console.log(
			`${m} ${id} ${who.padEnd(20)} ${String(a.reason).padEnd(9)} gain ${f(s.gainPct)}% sync ${f(s.sync, 1)}% lag ${s.lag} angle ${f(s.angle)} ` +
				`strafes/j ${f(s.strafesPerJump, 1)} turning ${f(s.turnPct, 1)}% landed ${s.landed}/${s.jumps} j1 ${s.j1 ? f(s.j1.pct) : '-'}% ` +
				`vmax ${f(s.speedMax, 0)} vavg ${f(s.speedAvg, 0)} vend ${f(s.speedEnd, 0)} | ` +
				`band ${f(s.inBand, 1)}% swaps ${s.swaps.length} time ${f(s.swapTime, 1)} eff ${f(s.swapEff, 1)}% lost@swaps ${f(s.swapLostShare, 0)}% ` +
				`peak ${f(s.peak)} over/under ${s.over}/${s.under} key ${f(s.keyOff, 1)}`
		);
	}
}
