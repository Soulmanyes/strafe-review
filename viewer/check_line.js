#!/usr/bin/env node
'use strict';
// Checks the recorder's in-game jump-1 line (its TS port of the jump-1 stats) against the viewer's
// own code (static/data.js, static/checks.js, the drill page's per-strafe gain %).
//
//   node viewer/check_line.js [--store DIR]           feed every saved own attempt row by row through
//                                                    the recorder code
//   node viewer/check_line.js --interval 0.015       the same, with every attempt taken as recorded at
//                                                    this tick interval (tickrate-scaled checks)
//   node viewer/check_line.js --log [yaw.log]         compare the SRLINE lines the game logged
//
// Prints one line per attempt and a mismatch count; exits 1 if anything differs.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const { stripTypeScriptTypes } = require('module');

const data = require('./static/data.js');
Object.assign(globalThis, data);
const { runChecks, strafesOf, strafing } = require('./static/checks.js');

const args = process.argv.slice(2);
const at = args.indexOf('--store');
const store = at >= 0 ? args[at + 1] : path.join(process.env.HOME, '.local/share/strafe-review/attempts');
const iv = args.indexOf('--interval');
const forceInterval = iv >= 0 ? +args[iv + 1] : null;
const GAME = path.join(process.env.HOME, '.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum');
const RECORDER = path.join(__dirname, '../recorder/panorama/scripts/hud/strafe-review.ts');
const DELAY = 3; // LINE_DELAY_ROWS in the recorder

const files = new Map();
for (const m of fs.readdirSync(store)) {
	const dir = path.join(store, m);
	if (!fs.statSync(dir).isDirectory()) continue;
	for (const f of fs.readdirSync(dir)) if (f.endsWith('.json.gz')) files.set(f.slice(0, -8), path.join(dir, f));
}
const load = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString());

// The viewer's numbers for jump 1, rounded as the recorder logs them
function viewer(a) {
	const d = data.parse(a);
	const { jumps } = data.findJumps(d, a.preRows);
	const endIdx = a.postRows ? d.n - 1 - a.postRows : d.n - 1;
	const j = jumps.find((x) => x.num === 1);
	if (!j || j.e > endIdx || j.e >= d.n) return null;
	const strafes = strafesOf(d, j, endIdx).map((st) => {
		let g = 0;
		let id = 0;
		for (let i = st.i0; i <= st.i1; i++) {
			if (strafing(d, i) && Number.isFinite(d.gain[i]) && Number.isFinite(d.ideal[i])) {
				g += d.gain[i];
				id += d.ideal[i];
			}
		}
		return [st.dir, id > 0 ? +((100 * g) / id).toFixed(3) : null];
	});
	const off = { takeoff: { on: false }, balance: { on: false } };
	const mistakes = runChecks(d, jumps, endIdx, off, null, false)
		.filter((m) => m.jump === 1)
		.map((m) => [m.check, m.i0, +m.lost.toFixed(3)]);
	return { s: j.s, e: j.e, land: +j.land.toFixed(3), pct: +j.pct.toFixed(3), strafes, mistakes };
}

// The recorder file run with stub Panorama APIs; returns its workOutLine
function recorder() {
	const msgs = [];
	const stub = new Proxy({}, { get: () => () => ({ state: 0, x: 0, y: 0, z: 0 }) });
	const ctx = {
		$: {
			Msg: (t) => msgs.push(t),
			Schedule: () => 0,
			RegisterForUnhandledEvent: () => 0,
			GetContextPanel: () => ({ GetParent: () => null, FindChildTraverse: () => null }),
			// any panel method is a no-op that answers true
			CreatePanel: () => new Proxy({}, { get: (_, k) => (k === 'visible' ? true : () => true) })
		},
		MomentumMovementAPI: { GetTickInterval: () => 0.01 },
		MomentumTimerAPI: stub,
		MomentumPlayerAPI: stub,
		MomentumInputAPI: stub,
		MomentumReplayAPI: stub,
		MapCacheAPI: stub,
		MomentumAPI: stub,
		Math,
		JSON,
		Number,
		Date
	};
	vm.createContext(ctx);
	const src = stripTypeScriptTypes(fs.readFileSync(RECORDER, 'utf8'), { mode: 'strip' });
	// Rows go in one at a time through lineStep(), as in the game, so the landing trigger is tested too
	vm.runInContext(`${src}\nglobalThis.__step = (a, row) => { attempt = a; a.rows.push(row); lineStep(); };\nglobalThis.__interval = (v) => { interval = v; };`, ctx);
	return (id, rows, preRows, iv) => {
		msgs.length = 0;
		ctx.__interval(iv);
		const a = { id, rows: [], preRows, tail: null, line: { done: false, seen: 0, at: -1 } };
		for (const row of rows) {
			ctx.__step(a, row);
			if (msgs.length) break;
		}
		const m = msgs.find((t) => t.startsWith('SRLINE '));
		return m ? { at: a.rows.length, ...JSON.parse(m.slice(m.indexOf('{'))) } : null;
	};
}

// Round-trips through JSON so NaN reads as null on both sides
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

function diff(id, got, want) {
	const bad = [];
	for (const k of ['s', 'e', 'land', 'pct', 'strafes', 'mistakes']) if (!same(got[k], want[k])) bad.push(`${k}: game ${JSON.stringify(got[k])} viewer ${JSON.stringify(want[k])}`);
	const top = want.mistakes[0];
	console.log(
		`${bad.length ? 'DIFF' : 'ok  '} ${id} land ${want.land.toFixed(1)} gain ${want.pct.toFixed(2)} % strafes ${want.strafes.length} top ${top ? `${top[0]} -${top[2].toFixed(1)}` : '-'}`
	);
	for (const b of bad) console.log(`     ${b}`);
	return bad.length > 0;
}

let checked = 0;
let bad = 0;
if (args.includes('--log')) {
	const li = args.indexOf('--log');
	const log = args[li + 1] && !args[li + 1].startsWith('--') ? args[li + 1] : path.join(GAME, 'yaw.log');
	for (const ln of fs.readFileSync(log, 'latin1').split('\n')) {
		const m = ln.match(/SRLINE (\S+) (\{.*\})/);
		if (!m) continue;
		const f = files.get(m[1]);
		if (!f) {
			console.log(`skip ${m[1]}: not saved (yet)`);
			continue;
		}
		const want = viewer(load(f));
		if (!want) {
			console.log(`skip ${m[1]}: viewer finds no landed jump 1`);
			continue;
		}
		checked++;
		if (diff(m[1], JSON.parse(m[2]), want)) bad++;
	}
} else {
	const work = recorder();
	for (const [id, f] of files) {
		const a = load(f);
		if (a.label !== 'own') continue;
		if (forceInterval) a.interval = forceInterval;
		const want = viewer(a);
		// parse() relabels old spectated recordings as 'spectate'
		if (!want || a.label !== 'own') continue;
		const got = work(id, a.rows.split(';'), a.preRows, a.interval);
		checked++;
		if (!got) {
			console.log(`DIFF ${id}: recorder shows no line`);
			bad++;
		} else if (diff(id, got, want)) bad++;
		else if (got.at !== want.e + 1 + DELAY) {
			console.log(`     shown at row ${got.at}, landing row ${want.e} (expected ${want.e + 1 + DELAY})`);
			bad++;
		}
	}
}
console.log(`${checked} checked, ${bad} differ`);
process.exit(bad ? 1 : 0);
