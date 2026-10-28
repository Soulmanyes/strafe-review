#!/usr/bin/env node
'use strict';
// Checks the viewer's CS:S (SSJ) gain against the game's own wish velocity. Attempts recorded since
// 2026-10-28 carry wx/wy (GetMoveHudData().wishVel). For each air row it compares p = previous velocity
// · wishdir taken from wishVel with p from the velocity change (what ssjRow() uses), at row offsets -1..1
// for wishVel, and the per-jump SSJ % both ways.
//
//   node viewer/check_ssj.js [--store DIR] [id ...]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const data = require('./static/data.js');

const args = process.argv.slice(2);
const at = args.indexOf('--store');
const store = at >= 0 ? args[at + 1] : path.join(process.env.HOME, '.local/share/strafe-review/attempts');
const only = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
const A = data.AIR_ADD;

// p from wishVel at row k for the move of row i (previous velocity = row i - 1); null without a wish
function pWish(d, i, k) {
	if (k < 0 || k >= d.n) return null;
	const l = Math.hypot(d.wx[k], d.wy[k]);
	if (!(l > 0.1)) return null;
	return (d.vx[i - 1] * d.wx[k] + d.vy[i - 1] * d.wy[k]) / l;
}
const score = (p) => (p === null ? 1 : p < A ? (A - Math.abs(p)) / A : 0); // no key: 1, as SSJ scores it

let files = 0;
for (const m of fs.readdirSync(store)) {
	const dir = path.join(store, m);
	if (!fs.statSync(dir).isDirectory()) continue;
	for (const file of fs.readdirSync(dir).sort()) {
		if (!file.endsWith('.json.gz')) continue;
		const id = file.replace('.json.gz', '');
		if (only.length && !only.includes(id)) continue;
		const a = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, file))).toString());
		if (!a.cols.includes('wx')) continue;
		files++;
		const d = data.parse(a);
		const { jumps } = data.findJumps(d, a.preRows);
		const fit = data.angleFit(d);
		// per-row p agreement at wishVel offsets -1, 0, 1 (rows with a wish and an air move under 60 u/s)
		const res = [-1, 0, 1].map((o) => {
			const diffs = [];
			for (const j of jumps) {
				if (!j.num) continue;
				for (let i = j.s + 1; i <= Math.min(j.e, d.n - 1); i++) {
					if (d.gap[i] > 0) continue;
					const pw = pWish(d, i, i + o);
					if (pw === null) continue;
					const r = data.ssjRow(d, i, fit, false);
					if (!r.ok) continue;
					const m2 = Math.hypot(d.vx[i] - d.vx[i - 1], d.vy[i] - d.vy[i - 1]);
					if (pw >= A && m2 < 0.01) continue; // no air move either way: nothing to compare
					diffs.push(Math.abs(pw - (A - m2)));
				}
			}
			diffs.sort((x, y) => x - y);
			const q = (f) => (diffs.length ? diffs[Math.floor(f * (diffs.length - 1))].toFixed(3) : '-');
			return { o, n: diffs.length, med: q(0.5), p90: q(0.9), max: q(1) };
		});
		const best = res.reduce((b, r) => (r.n && (!b || +r.med < +b.med) ? r : b), null);
		console.log(`${m} ${id} ${a.label} ${a.reason} angle lag ${fit.lag} (err ${Number.isFinite(fit.err) ? fit.err.toFixed(3) : '-'})`);
		for (const r of res) console.log(`  wishVel row ${r.o >= 0 ? '+' : ''}${r.o}: ${r.n} rows, |p diff| median ${r.med} p90 ${r.p90} max ${r.max}${r === best ? '  <- best' : ''}`);
		if (!best) continue;
		// per-jump SSJ %: viewer (velocity) vs wishVel at the best offset, same rows
		const lines = [];
		for (let k = 0; k < jumps.length; k++) {
			const j = jumps[k];
			if (!j.num) continue;
			let s = 0;
			let n = 0;
			for (let i = j.s + 1; i <= Math.min(j.e, d.n - 1); i++) {
				if (!data.ssjRow(d, i, fit, false).ok) continue;
				s += score(pWish(d, i, i + best.o));
				n++;
			}
			const nx = jumps[k + 1];
			if (nx && nx.s - j.e <= 10 && data.ssjRow(d, nx.s, fit, true).ok) {
				s += score(pWish(d, nx.s, nx.s + best.o));
				n++;
			}
			lines.push(`${j.num}: ${j.ssj.toFixed(2)} / ${n ? ((100 * s) / n).toFixed(2) : '-'}`);
		}
		console.log(`  per jump SSJ % viewer / wishVel: ${lines.join('  ')}`);
	}
}
if (!files) console.log('No attempts with wx/wy yet: panorama_reload in game, then do some runs.');
