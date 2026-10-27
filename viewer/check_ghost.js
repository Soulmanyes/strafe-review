#!/usr/bin/env node
'use strict';
// Checks the ghost alignment (alignGhost() in static/data.js) over every pair of saved attempts on the
// same map and tickrate: in per-jump mode each matched takeoff must land exactly on the open attempt's
// takeoff, and the ghost's x must never go down.
//
//   node viewer/check_ghost.js [--store DIR]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parse, findJumps, alignGhost } = require('./static/data.js');

const args = process.argv.slice(2);
const at = args.indexOf('--store');
const store = at >= 0 ? args[at + 1] : path.join(process.env.HOME, '.local/share/strafe-review/attempts');

const groups = new Map();
for (const m of fs.readdirSync(store)) {
	const dir = path.join(store, m);
	if (!fs.statSync(dir).isDirectory()) continue;
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith('.json.gz')) continue;
		const a = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString());
		const d = parse(a);
		const key = `${m}|${a.interval}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push({ id: f, d, ...findJumps(d, a.preRows) });
	}
}

let pairs = 0;
let bad = 0;
let fallback = 0;
let dropped = 0;
let rows = 0;
for (const [key, atts] of groups) {
	for (const cur of atts) {
		for (const cmp of atts) {
			if (cur === cmp) continue;
			pairs++;
			const g = alignGhost(cur, cmp, 'jump');
			if (g.mode !== 'jump') {
				fallback++;
				continue;
			}
			const errs = [];
			for (const j of cmp.jumps) {
				const o = cur.jumps.find((jj) => jj.num === j.num && j.num > 0);
				if (o && g.x[j.s] !== o.x0) errs.push(`jump ${j.num} takeoff at ${g.x[j.s]}, want ${o.x0}`);
			}
			let last = -Infinity;
			for (let i = 0; i < cmp.d.n; i++) {
				rows++;
				if (!Number.isFinite(g.x[i])) {
					dropped++;
					continue;
				}
				if (g.x[i] < last) errs.push(`row ${i}: x ${g.x[i]} after ${last}`);
				last = g.x[i];
			}
			if (errs.length) {
				bad++;
				console.log(`${key} ${cur.id} <- ${cmp.id}: ${errs.slice(0, 3).join('; ')}${errs.length > 3 ? ` (+${errs.length - 3})` : ''}`);
			}
		}
	}
}
console.log(`${pairs} pairs, ${bad} with errors, ${fallback} fell back to timer (no common jump), ${dropped}/${rows} ghost rows left out`);
process.exit(bad ? 1 : 0);
