#!/usr/bin/env node
'use strict';
// Checks the top-down path (buildPath() in static/data.js) on every saved attempt: the timer start sits
// at (0, 0), rows after it all get a position, and finished runs on one map and track end close together
// (the finish zone), which shows the integration doesn't drift. The path is turned so the way out of the
// start zone points up: the first row 32+ units from the timer start must sit straight above it.
//
//   node viewer/check_path.js [--store DIR] [--list]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parse, buildPath, pathDistance, runEnd } = require('./static/data.js');

const args = process.argv.slice(2);
const at = args.indexOf('--store');
const store = at >= 0 ? args[at + 1] : path.join(process.env.HOME, '.local/share/strafe-review/attempts');
const listAll = args.includes('--list');

let files = 0;
let bad = 0;
const ends = new Map(); // "<map>|track" -> [[x, y, label, id]]
for (const m of fs.readdirSync(store)) {
	const dir = path.join(store, m);
	if (!fs.statSync(dir).isDirectory()) continue;
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith('.json.gz')) continue;
		const a = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString());
		const d = parse(a);
		if (!d.n) continue;
		files++;
		const { x, y, brk } = buildPath(d, a.interval, a.preRows);
		const p = Math.min(a.preRows || 0, d.n - 1);
		let after = 0;
		for (let i = p; i < d.n; i++) if (!Number.isFinite(x[i])) after++;
		let breaks = 0;
		let before = 0;
		for (let i = 0; i < d.n; i++) {
			if (brk[i] && i !== p) breaks++;
			if (i < p && !Number.isFinite(x[i])) before++;
		}
		let up = true;
		for (let i = p + 1; i < d.n && !brk[i]; i++) {
			if (Math.hypot(x[i], y[i]) < 32) continue;
			up = Math.abs(x[i]) < 1e-6 && y[i] > 0;
			break;
		}
		const dist = pathDistance({ x, y, brk }, p, runEnd(a, d));
		const ok = x[p] === 0 && y[p] === 0 && after === 0 && up;
		if (!ok) bad++;
		const end = a.postRows ? d.n - 1 - a.postRows : d.n - 1;
		if (listAll || !ok)
			console.log(
				`${ok ? 'ok ' : 'BAD'} ${m}/${f} ${a.label} ${a.reason} rows ${d.n} breaks ${breaks} unplaced-before-start ${before}${up ? '' : ' NOT-UP'} dist ${dist.toFixed(0)} end (${x[end].toFixed(0)}, ${y[end].toFixed(0)})`
			);
		if (a.reason === 'finish') {
			const key = `${m}|${a.track ? `${a.track.type}/${a.track.number}` : '?'}`;
			if (!ends.has(key)) ends.set(key, []);
			ends.get(key).push([x[end], y[end], a.label, f, dist]);
		}
	}
}

console.log(`${files} attempts, ${bad} bad`);
for (const [key, pts] of ends) {
	const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
	const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
	const far = Math.max(...pts.map((p) => Math.hypot(p[0] - mx, p[1] - my)));
	console.log(`finish ends ${key}: ${pts.length} runs, mean (${mx.toFixed(0)}, ${my.toFixed(0)}), farthest ${far.toFixed(0)} units from it, distance ${Math.min(...pts.map((p) => p[4])).toFixed(0)}-${Math.max(...pts.map((p) => p[4])).toFixed(0)} units`);
	if (listAll) for (const p of pts) console.log(`  ${p[3]} ${p[2]} (${p[0].toFixed(0)}, ${p[1].toFixed(0)})`);
}
process.exit(bad ? 1 : 0);
