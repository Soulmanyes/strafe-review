#!/usr/bin/env node
'use strict';
// Checks the top-down path (buildPath() in static/data.js) on every saved attempt: the timer start sits
// at (0, 0), rows after it all get a position, and finished runs on one map and track end close together
// (the finish zone), which shows the integration doesn't drift. The path is turned so the way out of the
// start zone points up: 1000 units along, the path must be within 25 degrees of straight up.
// Overlays (the ghost on the main page, /compare) turn every path like the reference's (turnPath()):
// per map and tickrate, each attempt is turned like the map's most common turn, and its velocity at the
// timer start (world data, unlike a short drill's curved path) must then point within 45 degrees of up.
// Attempts whose own turn differs are the ones this fixes.
//
//   node viewer/check_path.js [--store DIR] [--list]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parse, buildPath, pathDistance, runEnd, turnPath } = require('./static/data.js');

const args = process.argv.slice(2);
const at = args.indexOf('--store');
const store = at >= 0 ? args[at + 1] : path.join(process.env.HOME, '.local/share/strafe-review/attempts');
const listAll = args.includes('--list');

let files = 0;
let bad = 0;
const ends = new Map(); // "<map>|track" -> [[x, y, label, id]]
const groups = new Map(); // "<map>|<interval>" -> [{ f, path, far }]
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
		// the point 1000 units along (or the farthest before a break) must lie in the upper half, within 25 degrees of up
		let far = p;
		let along = 0;
		for (let i = p + 1; i < d.n && !brk[i] && along < 1000; i++) {
			along += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
			far = i;
		}
		if (!groups.has(`${m}|${a.interval}`)) groups.set(`${m}|${a.interval}`, []);
		groups.get(`${m}|${a.interval}`).push({ f, path: buildPath(d, a.interval, a.preRows), far, v: [d.vx[p], d.vy[p]] });
		const up = Math.hypot(x[far], y[far]) < 32 || Math.abs(Math.atan2(x[far], y[far])) <= (25 * Math.PI) / 180 + 1e-9;
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
// overlays: turned like the map's most common turn
let turnBad = 0;
for (const [key, atts] of groups) {
	const count = new Map();
	for (const t of atts) count.set(t.path.turn.toFixed(6), (count.get(t.path.turn.toFixed(6)) || 0) + 1);
	const common = Number([...count].sort((a, b) => b[1] - a[1])[0][0]);
	let differ = 0;
	let off = 0;
	for (const t of atts) {
		const q = turnPath(t.path, common);
		// turning to its own turn changes nothing; turning there and back gives the same points
		const back = turnPath(q, t.path.turn);
		const same = turnPath(t.path, t.path.turn) === t.path && Math.abs(back.x[t.far] - t.path.x[t.far]) < 1e-6 && Math.abs(back.y[t.far] - t.path.y[t.far]) < 1e-6;
		if (!same) turnBad++;
		if (Math.abs(t.path.turn - common) < 1e-6) continue;
		differ++;
		const c = Math.cos(common);
		const sn = Math.sin(common);
		const dx = t.v[0] * c - t.v[1] * sn;
		const dy = t.v[0] * sn + t.v[1] * c;
		const ok = Math.hypot(dx, dy) < 50 || Math.abs(Math.atan2(dx, dy)) <= Math.PI / 4;
		if (!ok) off++;
		if (listAll || !ok) console.log(`  ${ok ? 'ok ' : 'OFF'} overlay ${key} ${t.f} own turn ${((t.path.turn * 180) / Math.PI).toFixed(0)}, start velocity ${((Math.atan2(dx, dy) * 180) / Math.PI).toFixed(0)}° from up`);
	}
	console.log(`overlay ${key}: ${atts.length} attempts, common turn ${((common * 180) / Math.PI).toFixed(0)}°, ${differ} with another own turn, ${off} of those point over 45° off up`);
}
if (turnBad) console.log(`turnPath round trip wrong on ${turnBad} attempts`);
process.exit(bad || turnBad ? 1 : 0);
