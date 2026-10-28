#!/usr/bin/env node
'use strict';
// Checks the automatic tags (static/autotags.js) on hand-made heads, then lists the tags the saved
// attempts get.
//
//   node viewer/check_autotags.js [--store DIR]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

Object.assign(globalThis, require('./static/data.js'));
const { autoTags } = require('./static/autotags.js');

const args = process.argv.slice(2);
const at = args.indexOf('--store');
const store = at >= 0 ? args[at + 1] : path.join(process.env.HOME, '.local/share/strafe-review/attempts');

let bad = 0;
const same = (what, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) bad++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
};

const H = 3600e3;
let t = 0;
// one own attempt per call, a minute apart unless gap (ms) says otherwise
const att = (sens, extra = {}, gap = 60e3) => {
	t += gap;
	return { id: `a${t}`, dir: 'm', interval: 0.01, label: 'own', started: t, mouse: sens === null ? undefined : { sensitivity: sens, m_yaw: 0.022, dpi: 800 }, ...extra };
};
const tagsOf = (l) => l.map((h) => h.auto.join('+') || '-');

// sens: baseline untagged; a new one tagged for 24 h; a short trial and back untagged
t = 0;
let l = [att(2), att(2), att(1.6), att(1.6), att(1.6, {}, 25 * H), att(2), att(2)];
autoTags(l, { oldMin: 75 });
same('new sens for 24 h, short trial back = nothing', tagsOf(l), ['-', '-', 'new sens', 'new sens', '-', '-', '-']);

// back to an old sens after oldMin attempts away = old sens; fewer = nothing
t = 0;
l = [att(2), att(1.6), att(1.6), att(1.6), att(2), att(1.6)];
autoTags(l, { oldMin: 3 });
same('old sens after 3 away; 1 away = nothing', tagsOf(l), ['-', 'new sens', 'new sens', 'new sens', 'old sens', '-']);

// unstamped attempts (no mouse) are skipped: the first stamped sens is the baseline
t = 0;
l = [att(null), att(null), att(2), att(1.8)];
autoTags(l, { oldMin: 75 });
same('unstamped skipped, first stamped = baseline', tagsOf(l), ['-', '-', '-', 'new sens']);

// a missing DPI keeps the one before; a DPI change counts as a new sens
t = 0;
l = [att(2), att(2), att(2)];
l[1].mouse.dpi = null;
l[2].mouse.dpi = 1600;
autoTags(l, { oldMin: 75 });
same('null DPI inherits, DPI change = new sens', tagsOf(l), ['-', '-', 'new sens']);

// replays never tagged; PB per map/tick/style/track, practice and non-finishes skipped
t = 0;
const fin = (rt, extra = {}) => att(null, { reason: 'finish', runTime: rt, track: { type: 0, number: 1 }, ...extra });
l = [fin(30), fin(31), att(null, { reason: 'reset' }), fin(29, { practice: true }), fin(29.5), fin(25, { label: 'replay' }), fin(40, { style: 3 }), fin(35, { track: { type: 1, number: 1 } }), fin(29.5)];
autoTags(l, { oldMin: 75 });
same('PB', tagsOf(l), ['PB', '-', '-', '-', 'PB', '-', 'PB', 'PB', '-']);

// the saved attempts
const heads = [];
for (const dir of fs.existsSync(store) ? fs.readdirSync(store) : []) {
	const p = path.join(store, dir);
	if (!fs.statSync(p).isDirectory()) continue;
	for (const f of fs.readdirSync(p).filter((x) => x.endsWith('.json.gz'))) {
		const h = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(p, f))));
		delete h.rows;
		h.dir = dir;
		heads.push(h);
	}
}
autoTags(heads, { oldMin: 75 });
const counts = {};
for (const h of heads) for (const x of h.auto) counts[x] = (counts[x] || 0) + 1;
console.log(`\n${heads.length} saved attempts, ${heads.filter((h) => h.mouse).length} with sens stamped; tags: ${JSON.stringify(counts)}`);
for (const h of heads.filter((x) => x.auto.includes('PB')).sort((a, b) => a.started - b.started))
	console.log(`  PB ${h.dir} ${h.id} ${h.runTime.toFixed(3)} s ${new Date(h.started).toISOString().slice(0, 16)}`);

if (bad) {
	console.log(`\n${bad} failed`);
	process.exit(1);
}
