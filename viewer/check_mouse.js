#!/usr/bin/env node
'use strict';
// Checks the mouse-terms numbers (static/mouse.js): the cm formula against Momentum's mouse settings
// page, strafeTurn() on hand-made rows, then prints jump-1 strafes of saved own attempts in cm.
//
//   node viewer/check_mouse.js [--store DIR] [--dpi N]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const data = require('./static/data.js');
Object.assign(globalThis, data);
const checks = require('./static/checks.js');
Object.assign(globalThis, checks);
const { mouseFor, strafeTurn, cmText, cmPerSec } = require('./static/mouse.js');

const args = process.argv.slice(2);
const at = args.indexOf('--store');
const store = at >= 0 ? args[at + 1] : path.join(process.env.HOME, '.local/share/strafe-review/attempts');
const di = args.indexOf('--dpi');
const DPI = di >= 0 ? +args[di + 1] : 800;

let bad = 0;
const near = (what, got, want, tol = 1e-9) => {
	const ok = Math.abs(got - want) <= tol;
	if (!ok) bad++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got} (want ${want})`);
};

// 1. Formula. Momentum's page: per360 = 360 / (dpi * sens * m_yaw) inches, * 2.54 for cm.
const m = mouseFor({ mouse: { sensitivity: 0.733, m_yaw: 0.012, dpi: null } }, null, 800);
near('cm/360 at sens 0.733, m_yaw 0.012, 800 DPI', 360 * m.cmPerDeg, (360 / (800 * 0.733 * 0.012)) * 2.54);
near('recorded sens used', m.recorded ? 1 : 0, 1);
const cur = mouseFor({}, { sensitivity: 1, m_yaw: 0.022 }, 400);
near('fallback to current sens', cur.recorded ? 0 : 1, 1);
near('cm/360 at sens 1, m_yaw 0.022, 400 DPI', 360 * cur.cmPerDeg, 103.90909090909092, 1e-9);
near('no DPI gives null', mouseFor({ mouse: { sensitivity: 1, m_yaw: 0.022 } }, null, null) === null ? 1 : 0, 1);
near('cm/s: 1°/tick at 100 tick, 1 cm/°', cmPerSec(1, 0.01, { cmPerDeg: 1 }), 100);

// 2. strafeTurn on 6 rows of a left strafe (dir +1): row 2 holds +left, row 4 is a missed-tick row
const d = {
	yawd: [1, 1.5, 3, -0.2, 9, 1],
	opt: [1, 1, 1, 1, 1, 1],
	buttons: [0, 0, BIT.LEFT, 0, 0, 0],
	ground: [0, 0, 0, 0, 0, 0],
	speed: [300, 300, 300, 300, 300, 300],
	gain: [1, 1, 1, 1, 1, 1]
};
d.yawd[4] = NaN; // missed tick before it: no yaw step
const t = strafeTurn(d, { dir: 1, i0: 0, i1: 5 });
// counted rows 0, 1, 3, 5: 1 + 1.5 - 0.2 + 1 = 3.3 net, opt 4
near('strafeTurn did (net, +left and missed rows left out)', t.did, 3.3, 1e-12);
near('strafeTurn opt', t.opt, 4);
near('strafeTurn ticks', t.ticks, 4);
const r = strafeTurn(d, { dir: -1, i0: 0, i1: 1 });
near('strafeTurn right strafe turning left reads negative', r.did, -2.5);

// 3. Saved own attempts: jump-1 strafes in cm, with the turn ratio for a sanity look
const files = [];
for (const dir of fs.readdirSync(store)) {
	const p = path.join(store, dir);
	if (!fs.statSync(p).isDirectory()) continue;
	for (const f of fs.readdirSync(p)) if (f.endsWith('.json.gz')) files.push(path.join(p, f));
}
console.log(`\njump-1 strafes of own attempts at ${DPI} DPI (sens from the attempt, else current config):`);
let shown = 0;
const ratios = [];
for (const f of files.sort()) {
	const a = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
	if (isOther(a)) continue;
	const dd = parse(a);
	const { jumps, j1 } = findJumps(dd, a.preRows);
	if (j1 < 0) continue;
	const mm = mouseFor(a, { sensitivity: 0.733, m_yaw: 0.012 }, DPI);
	const endIdx = a.postRows ? dd.n - 1 - a.postRows : dd.n - 1;
	const parts = [];
	for (const st of strafesOf(dd, jumps[j1], endIdx)) {
		const tt = strafeTurn(dd, st);
		if (!tt.ticks) continue;
		parts.push(`${st.dir > 0 ? 'A' : 'D'} ${cmText(tt.did, mm)}/${cmText(tt.opt, mm)}`);
		if (tt.ticks >= 10) ratios.push(tt.did / tt.opt);
	}
	if (shown++ < 15) console.log(`  ${a.id}${mm.recorded ? '' : '*'}  ${parts.join('  ')}`);
}
ratios.sort((x, y) => x - y);
console.log(`  ... ${shown} attempts (* = current sens). did/opt over strafes of 10+ ticks: median ${ratios[ratios.length >> 1]?.toFixed(2)}, n ${ratios.length}`);
console.log(bad ? `\n${bad} FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
