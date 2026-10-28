#!/usr/bin/env node
'use strict';
// Checks list sort and search (static/listsort.js) on hand-made heads, then on the heads a running
// viewer serves (j1Land and j1Takeoff are worked out by the server, not stored in the files).
//
//   node viewer/check_listsort.js [--url http://127.0.0.1:8765]

Object.assign(globalThis, require('./static/data.js'));
const { autoTags } = require('./static/autotags.js');
const { LIST_SORTS, sortHeads, matchesSearch } = require('./static/listsort.js');

const args = process.argv.slice(2);
const at = args.indexOf('--url');
const url = at >= 0 ? args[at + 1] : 'http://127.0.0.1:8765';

let bad = 0;
const same = (what, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) bad++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
};

const hs = [
	{ id: 'a', label: 'own', started: 1, reason: 'finish', runTime: 60, j1Takeoff: 290, j1Land: 330, tags: ['new mouse'], note: '' },
	{ id: 'b', label: 'own', started: 2, reason: 'fail', runTime: 5, j1Takeoff: 280, j1Land: null, tags: [], note: 'bad jump 1 again' },
	{ id: 'c', label: 'replay', player: 'Zed', started: 3, reason: 'finish', runTime: 50, j1Takeoff: 300, j1Land: 345 },
	{ id: 'd', label: 'replay', player: 'amy', started: 4, reason: 'replaced', runTime: 20, j1Takeoff: 285, j1Land: 340 },
	{ id: 'e', label: 'own', started: 5, reason: 'finish', runTime: 55, j1Takeoff: 270, j1Land: 330, auto: ['PB'] }
];
const ids = (key) => sortHeads(hs, key).map((h) => h.id).join('');
same('newest', ids('newest'), 'edcba');
same('oldest', ids('oldest'), 'abcde');
same('fastest finish, unfinished last', ids('finish'), 'ceadb');
same('jump 1 landing, tie newest first, null last', ids('j1land'), 'cdeab');
same('jump 1 gained, null last', ids('j1gain'), 'edcab');
same('player, case ignored, own runs last', ids('player'), 'dceba');
same('unknown key = newest', ids('nope'), 'edcba');
same('every sort has a label', LIST_SORTS.every((s) => s[1]), true);
const hits = (q) => hs.filter((h) => matchesSearch(h, q)).map((h) => h.id).join('');
same('empty search', hits('  '), 'abcde');
same('auto tag', hits('pb'), 'e');
same('own tag', hits('MOUSE'), 'a');
same('note, words ANDed', hits('jump again'), 'b');
same('words ANDed, one missing', hits('jump zed'), '');
same('player', hits('zed'), 'c');
same('label', hits('replay'), 'cd');

(async () => {
	let list;
	try {
		list = await (await fetch(`${url}/api/attempts`)).json();
	} catch {
		console.log(`no viewer at ${url}: real heads skipped`);
		process.exit(bad ? 1 : 0);
	}
	autoTags(list);
	console.log(`\n${list.length} saved heads`);
	for (const [key, label, get] of LIST_SORTS) {
		const s = sortHeads(list, key);
		const firstMissing = s.findIndex((h) => { const v = get(h); return v == null || (typeof v === 'number' && !Number.isFinite(v)); });
		const tail = firstMissing < 0 ? [] : s.slice(firstMissing);
		const ok = tail.every((h) => { const v = get(h); return v == null || (typeof v === 'number' && !Number.isFinite(v)); });
		if (!ok) bad++;
		const top = s.slice(0, 3).map((h) => `${whoseRun(h)} ${String(get(h)).slice(0, 13)}`).join(' | ');
		console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${firstMissing < 0 ? 0 : s.length - firstMissing} without a value, all last. Top: ${top}`);
	}
	const tagged = list.find((h) => h.auto?.length);
	if (tagged) same(`search finds auto tag "${tagged.auto[0]}"`, list.filter((h) => matchesSearch(h, tagged.auto[0])).includes(tagged), true);
	const noted = list.find((h) => h.note);
	if (noted) same('search finds a note', list.filter((h) => matchesSearch(h, noted.note.split(/\s+/)[0])).includes(noted), true);
	process.exit(bad ? 1 : 0);
})();
