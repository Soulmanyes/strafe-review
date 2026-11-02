#!/usr/bin/env node
'use strict';
// "Leave out last jump" (summarize()'s skipLast, runrows.js lastJumpOut()) on saved attempts: for every
// finished bhop run, the stats with and without the last jump. Fails if skipLast changes the jump counts,
// perJump or speeds, leaves a numbered jump out other than the last, or drops the only jump of a run.
//
//   node viewer/check_skiplast.js [--store DIR] [--list]

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
const listAll = args.includes('--list');

const f = (v, n = 1) => (Number.isFinite(v) ? v.toFixed(n) : '-');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let runs = 0;
let bad = 0;
for (const m of fs.readdirSync(store)) {
	const dir = path.join(store, m);
	if (!fs.statSync(dir).isDirectory() || /^surf_/i.test(m)) continue;
	for (const file of fs.readdirSync(dir).sort()) {
		if (!file.endsWith('.json.gz')) continue;
		const a = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, file))).toString());
		// the server's replay_finished() is not run here, so finished replays that ended 'replaced' are skipped
		if (a.reason !== 'finish') continue;
		const d = data.parse(a);
		const { jumps } = data.findJumps(d, a.preRows);
		const all = summarize(a, d, jumps);
		const out = summarize(a, d, jumps, { skipLast: true });
		runs++;
		const errs = [];
		for (const k of ['jumps', 'landed', 'perJump', 'speedMax', 'speedAvg', 'speedEnd', 'endIdx', 'j1', 'bestJump', 'worstJump']) {
			if (!same(all[k], out[k])) errs.push(`${k} changed`);
		}
		const last = all.perJump.length ? all.perJump[all.perJump.length - 1].num : null;
		if (all.jumps > 1 && out.skippedLast !== last) errs.push(`skippedLast ${out.skippedLast}, last jump ${last}`);
		if (all.jumps <= 1 && out.skippedLast !== null) errs.push('only jump left out');
		if (all.skippedLast !== null) errs.push('skippedLast set without skipLast');
		if (errs.length) bad++;
		if (listAll || errs.length) {
			console.log(
				`${m} ${file.replace('.json.gz', '')} ${isOther(a) ? 'other' : 'own  '} jump ${out.skippedLast ?? '-'} out: ` +
					`gain ${f(all.gainPct)} -> ${f(out.gainPct)} % sync ${f(all.sync)} -> ${f(out.sync)} % swaps ${all.swapsTimed} -> ${out.swapsTimed}` +
					(errs.length ? `  BAD: ${errs.join(', ')}` : '')
			);
		}
	}
}
console.log(`${runs} finished bhop runs, ${bad} bad`);
process.exit(bad ? 1 : 0);
