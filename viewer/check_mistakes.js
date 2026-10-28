#!/usr/bin/env node
'use strict';
// Runs the page's mistake checks (static/checks.js) over saved attempts and prints what they find,
// plus the strafe stats the defaults were set from. For tuning thresholds against real runs.
//
//   node viewer/check_mistakes.js [--store DIR] [--list]
//
// --list prints every mistake, not just the counts.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const data = require('./static/data.js');
Object.assign(globalThis, data);
const { CHECKS, MIN_TAKEOFF, runChecks, strafesOf, switchesOf, turnStart, median } = require('./static/checks.js');

const args = process.argv.slice(2);
const at = args.indexOf('--store');
const store = at >= 0 ? args[at + 1] : path.join(process.env.HOME, '.local/share/strafe-review/attempts');
const listAll = args.includes('--list');

const files = [];
for (const m of fs.readdirSync(store)) {
	const dir = path.join(store, m);
	if (!fs.statSync(dir).isDirectory()) continue;
	for (const f of fs.readdirSync(dir)) if (f.endsWith('.json.gz')) files.push(path.join(dir, f));
}

const pct = (vs, q) => {
	const s = [...vs].sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};

const loaded = files.map((f) => {
	const a = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString());
	const d = data.parse(a);
	const { jumps } = data.findJumps(d, a.preRows);
	const endIdx = a.postRows ? d.n - 1 - a.postRows : d.n - 1;
	return { a, d, jumps, endIdx };
});

// Baseline per map + interval: the other own attempts' jump-1 takeoff speeds, as the page builds it
// from the server's j1Takeoff
const takeoffs = {};
for (const { a, jumps } of loaded) {
	const j1 = jumps.find((j) => j.num === 1);
	if (isOther(a) || !j1 || j1.takeoff < MIN_TAKEOFF) continue;
	(takeoffs[`${a.map}@${a.interval}`] ||= []).push({ id: a.id, v: +j1.takeoff.toFixed(2) });
}

const firstLen = [];
const midLen = [];
const offsets = {};
const counts = Object.fromEntries(CHECKS.map((c) => [c.id, 0]));
const allOn = Object.fromEntries(CHECKS.map((c) => [c.id, { on: true }]));
for (const { a, d, jumps, endIdx } of loaded) {
	const own = !isOther(a);
	if (own) {
		for (const j of jumps) {
			if (!j.num || j.s > endIdx) continue;
			const st = strafesOf(d, j, endIdx);
			if (st.length > 1 && !st[0].gap) firstLen.push(d.tick[st[0].i1] - d.tick[turnStart(d, j.s, st[0].dir)] + 1);
			for (const m of st.slice(1, -1)) if (!m.gap) midLen.push(m.n);
			const sw = switchesOf(d, j, endIdx);
			for (const m of st.slice(1)) {
				let best = null;
				for (const w of sw) {
					if (w.dir !== m.dir) continue;
					const off = d.tick[w.i] - d.tick[m.i0];
					if (Math.abs(off) <= 8 && (best === null || Math.abs(off + 1) < Math.abs(best + 1))) best = off;
				}
				if (best !== null) offsets[best] = (offsets[best] || 0) + 1;
			}
		}
	}
	const vs = (takeoffs[`${a.map}@${a.interval}`] || []).filter((t) => t.id !== a.id).map((t) => t.v);
	const baseline = vs.length ? { takeoffMedian: median(vs), takeoffRuns: vs.length } : null;
	const found = runChecks(d, jumps, endIdx, allOn, baseline, !own);
	const per = {};
	for (const m of found) {
		counts[m.check]++;
		per[m.check] = (per[m.check] || 0) + 1;
	}
	const rows = endIdx - (a.preRows || 0) + 1;
	console.log(`${a.id} ${a.label.padEnd(8)} ${(a.reason || '?').padEnd(8)} ${String(rows).padStart(5)} rows  ` + Object.entries(per).map(([k, v]) => `${k} ${v}`).join(', '));
	if (listAll) for (const m of found) console.log(`    ${m.lost.toFixed(1).padStart(6)} u/s  ${m.name}: ${m.text}`);
}

console.log(`\n${loaded.length} attempts. Mistakes per check (all checks on):`);
for (const c of CHECKS) console.log(`  ${c.id.padEnd(10)} ${counts[c.id]}`);
const q = (vs) => `median ${median(vs)} (5-95 %: ${pct(vs, 0.05)}-${pct(vs, 0.95)}), n=${vs.length}`;
console.log(`\nOwn attempts: first strafe (from where its turn began) ${q(firstLen)}`);
console.log(`Middle strafes ${q(midLen)}`);
const offs = Object.entries(offsets).sort((x, y) => +x[0] - +y[0]);
console.log(`Switch offsets (ticks, target -1): ${offs.map(([k, v]) => `${k}: ${v}`).join(', ')}; ${offs.reduce((s, [, v]) => s + v, 0)} in total`);
for (const [k, vs] of Object.entries(takeoffs)) {
	console.log(`Jump-1 takeoff ${k}: ${q(vs.map((t) => t.v))}`);
	console.log(`  per attempt (compare with the server's j1Takeoff): ${vs.map((t) => `${t.id} ${t.v}`).join(', ')}`);
}
