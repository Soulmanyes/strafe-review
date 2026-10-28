'use strict';
// Strafe Review viewer: one zoomable graph per attempt, all lanes on a shared tick axis.
// x = tick - tick of the first run row (rows[preRows]), so 0 is where the timer started.

const COL = {
	card: '#232733',
	border: '#4a5468',
	grid: '#3a4152',
	text: '#e6e9ef',
	muted: '#a3abba',
	line: '#4fc3f7',
	raw: '#4fc3f766',
	opt: '#7bd88f',
	band: '#7bd88f2e',
	loss: '#c8d2e633', // neutral, so it never hides the red-green gain line
	idealGain: '#e6e9efaa',
	bad: '#ff5c5c',
	wide: '#ffb45499',
	narrow: '#6c9cff99',
	keyA: '#4fd1c5',
	keyD: '#ffb454',
	keyW: '#a3abba',
	turn: '#c792ea',
	ground: '#c8d2e61f',
	pre: '#6c9cff14',
	post: '#ff5c5c12',
	hover: '#ffffffcc',
	ghost: '#ff79c6'
};
const GUTTER = 128; // lane titles and y labels
const RIGHT_PAD = 12;
const LANE_GAP = 8;
const AXIS_H = 30;
const LANES = [
	{ id: 'jumps', h: 38, title: 'Jumps', sub: 'gain % of ideal' },
	{ id: 'yaw', h: 140, title: 'Yaw speed', sub: '°/tick vs optimal' },
	{ id: 'ratio', h: 110, title: 'Angle', sub: 'yawRatio, 1 = optimal' },
	{ id: 'gain', h: 140, title: 'Gain', sub: 'u/s, colour = gain %' },
	{ id: 'keys', h: 112, title: 'Keys', sub: 'held vs ideal' },
	{ id: 'speed', h: 120, title: 'Speed', sub: 'u/s, ground shaded' },
	{ id: 'gaps', h: 26, title: 'Missed ticks', sub: '' }
];
const KEY_ROWS = ['W', 'A', 'D', 'Ideal', 'Wrong', '+left/right'];
const REASONS = {
	finish: 'Finished',
	reset: 'Reset',
	stop: 'Stopped',
	zone: 'Back in start',
	savestate: 'Savestate',
	practice: 'Practice mode',
	target: 'Spec target changed',
	replaced: 'Replay stopped',
	level: 'Map change',
	restart: 'Restarted'
};

const $ = (id) => document.getElementById(id);
const base = $('base');
const over = $('over');
let list = [];
let cur = null; // { head, d, jumps, j1, tps, endIdx }
let view = { x0: 0, x1: 1 };
let hoverIdx = -1;
let drag = null;
let gutterText = []; // [text, y]: drawn after the lane clip is lifted
let selMistake = null; // the mistake picked in the list, outlined on the graph
let mouseNow = null; // the game's sensitivity and m_yaw now (/api/mouse), for attempts that didn't record theirs
let dpi = null; // mouse DPI typed in (mouse.js), or pre-filled from what Momentum stored
let pathFit = null; // { s, ox, oy, r0, r1 }: how the last path drawing maps world units to pixels
let pathView = null; // { s, cx, cy }: zoomed/panned path (scale, world centre); null = fit to pathRange()
let ghost = null; // { key, head, d, jumps, gd, order, mode, matched, how, path }: the comparison drawn dashed pink
const ghostCache = new Map(); // "<map>/<id>" -> { head, d, jumps, path }
const CMP_KEY = 'strafe-review-compare'; // { "<map>|<interval>": choice }
const ALIGN_KEY = 'strafe-review-align';
const SETTINGS_KEY = 'strafe-review-checks';
const DRILLS_KEY = 'strafe-review-show-drills';
const FILTERS_KEY = 'strafe-review-filters'; // { map, tick, style, result, tag }: "" = all
// Momentum's Style enum (common/web/enums/style.enum.ts); half-sideways is two values, bhop and surf
const STYLES = ['Normal', 'Half-Sideways (bhop)', 'Half-Sideways (surf)', 'Sideways', 'W-Only', 'A/D-Only', 'S-Only', 'Backwards', 'Pro', 'Teleport'];
const RESULTS = { finish: 'Finished', other: 'Not finished' };
const YAW_SIGNED_KEY = 'strafe-review-yaw-signed';
const PATH_WHOLE_KEY = 'strafe-review-path-whole';
const YAW_SUB = { size: '°/tick vs optimal', signed: '°/tick, + left, - right' };
// A drill: an own attempt that didn't finish and landed this many jumps or fewer (jump 1 or SSJ practice)
const DRILL_MAX_JUMPS = 7;


function isDrill(h) {
	return !isOther(h) && h.reason !== 'finish' && Number.isFinite(h.landed) && h.landed <= DRILL_MAX_JUMPS;
}

// A replay recording with no landed jump, or a shorter copy of a replay file recorded again (a replay
// that starts over after its end is recorded until it is stopped). Never listed unless it is open.
function isFragment(h) {
	if (!isOther(h)) return false;
	if (h.landed === 0) return true;
	const f = h.replayFile;
	return !!f && list.some((o) => o !== h && isOther(o) && o.replayFile === f && o.rowCount > h.rowCount);
}

function labelText(h) {
	return whoseRun(h);
}

function labelChip(h) {
	const el = document.createElement('span');
	const drill = isDrill(h);
	el.className = `chip ${isOther(h) ? 'replay' : drill ? 'drill' : 'own'}`;
	el.textContent = drill ? `Drill · ${h.landed} jump${h.landed === 1 ? '' : 's'}` : labelText(h);
	return el;
}

function reasonChip(h) {
	const el = document.createElement('span');
	el.className = `chip reason${h.reason === 'finish' ? ' finish' : ''}`;
	el.textContent = REASONS[h.reason] || h.reason || '?';
	return el;
}

function when(ms) {
	return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------- filters ----------

const FILTERS = [
	['map', 'f-map', (a) => a.dir, (v) => v],
	['tick', 'f-tick', (a) => String(Math.round(1 / a.interval)), (v) => `${v} tick`],
	['style', 'f-style', (a) => String(a.style ?? 0), (v) => STYLES[v] || `style ${v}`],
	['result', 'f-result', (a) => (a.reason === 'finish' ? 'finish' : 'other'), (v) => RESULTS[v]],
	['tag', 'f-tag', allTags, (v) => v]
];

function loadFilters() {
	try {
		return JSON.parse(localStorage.getItem(FILTERS_KEY)) || {};
	} catch {
		return {};
	}
}

// Each select lists only the values the saved attempts have. A choice that no attempt has any more
// shows as All; a select with a single value is greyed out.
function fillFilters() {
	const saved = loadFilters();
	const pool = list.filter((a) => !isFragment(a));
	for (const [key, id, get, name] of FILTERS) {
		const vals = [...new Set(pool.flatMap((a) => get(a)))].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
		const sel = $(id);
		sel.replaceChildren(new Option('All', ''), ...vals.map((v) => new Option(name(v), v)));
		sel.value = vals.includes(saved[key]) ? saved[key] : '';
		sel.disabled = key === 'tag' ? !vals.length : vals.length < 2;
	}
}

function passesFilters(a) {
	for (const [, id, get] of FILTERS) {
		const want = $(id).value;
		if (want && ![get(a)].flat().includes(want)) return false;
	}
	return true;
}

function filtersChanged() {
	const out = {};
	for (const [key, id] of FILTERS) if ($(id).value) out[key] = $(id).value;
	localStorage.setItem(FILTERS_KEY, JSON.stringify(out));
	renderList();
}

// Listed: not a replay fragment, a drill only with "Show drills", and through the filters
function shown(a) {
	return ($('show-drills').checked || !isDrill(a)) && !isFragment(a) && passesFilters(a);
}

// ---------- list ----------

async function loadList() {
	list = await (await fetch('/api/attempts')).json();
	applyWanted(); // edits still on their way to the server
	autoTags(list);
	fillFilters();
	fillTagList();
	renderList();
	findMistakes(); // the takeoff baseline comes from the list
	if (cur) {
		fillCompare();
		const h = choiceHead();
		if ((h ? `${h.dir}/${h.id}` : null) !== (ghost ? ghost.key : null)) {
			await setGhostSafe();
			showHead();
			draw();
		}
	}
}

function renderList() {
	const box = $('list');
	const scroll = box.scrollTop; // rebuilt on every open and save; stay where the owner scrolled to
	box.replaceChildren();
	if (!list.length) box.textContent = 'No attempts saved yet.';
	$('drill-count').textContent = list.filter(isDrill).length;
	// the open attempt stays listed even when it is a hidden drill or filtered out
	const openKey = cur ? `${cur.head.dir}/${cur.head.id}` : location.hash.slice(1).split('/').slice(0, 2).join('/');
	const visible = list.filter((a) => `${a.dir}/${a.id}` === openKey || shown(a));
	const total = list.filter((a) => !isFragment(a)).length;
	const hits = list.filter(shown).length;
	const drills = $('show-drills').checked ? 0 : list.filter((a) => isDrill(a) && !isFragment(a) && passesFilters(a)).length;
	$('f-count').textContent = `${hits} of ${total} shown${drills ? `, ${drills} more in drills` : ''}`;
	$('f-clear').hidden = !FILTERS.some(([, id]) => $(id).value);
	const maps = [...new Set(visible.map((a) => a.dir))];
	for (const m of maps) {
		const title = document.createElement('div');
		title.className = 'map-name';
		title.textContent = m;
		box.append(title);
		for (const a of visible.filter((x) => x.dir === m)) {
			const b = document.createElement('button');
			b.className = 'att';
			b.dataset.key = `${a.dir}/${a.id}`;
			const r1 = document.createElement('div');
			r1.className = 'row1';
			r1.append(labelChip(a), reasonChip(a));
			const r2 = document.createElement('div');
			r2.className = 'row2';
			const t = a.runTime ? `${a.runTime.toFixed(2)} s` : '';
			r2.textContent = [when(a.started), t, `${a.runGaps ?? a.gaps} missed`].filter(Boolean).join(' · ');
			b.append(r1, r2);
			if (a.tags?.length || a.auto?.length || a.note) {
				const r3 = document.createElement('div');
				r3.className = 'row3';
				for (const t of autoOnly(a)) r3.append(autoChip(t));
				for (const t of a.tags || []) {
					const c = document.createElement('span');
					c.className = 'chip tag';
					c.textContent = t;
					r3.append(c);
				}
				if (a.note) {
					const n = document.createElement('span');
					n.className = 'note-snip';
					n.textContent = a.note;
					n.title = a.note;
					r3.append(n);
				}
				b.append(r3);
			}
			b.onclick = () => open(a.dir, a.id);
			box.append(b);
		}
	}
	if (list.length && !visible.length) {
		const n = document.createElement('div');
		n.className = 'muted';
		n.textContent = 'No attempt matches the filters.';
		box.append(n);
	}
	markSelected();
	box.scrollTop = scroll;
}

// ---------- note and tags ----------

const listEntry = () => cur && list.find((a) => a.dir === cur.head.dir && a.id === cur.head.id);

function fillTagList() {
	const tags = [...new Set(list.flatMap((a) => a.tags || []))].sort((x, y) => x.localeCompare(y));
	$('tag-list').replaceChildren(...tags.map((t) => new Option(t)));
}

// Automatic tags the attempt doesn't also have as an own tag (that one shows, with its ×)
const autoOnly = (a) => (a.auto || []).filter((t) => !(a.tags || []).some((o) => o.toLowerCase() === t.toLowerCase()));

function autoChip(t) {
	const c = document.createElement('span');
	c.className = 'chip tag auto';
	c.textContent = t;
	c.title = 'Automatic tag, worked out from the recordings';
	return c;
}

// The editor sits outside #head, so a list refresh (a new attempt saved) never wipes what is being typed
function showMeta() {
	const e = listEntry();
	$('meta').hidden = !cur;
	if (!cur) return;
	const tags = e?.tags || [];
	const box = $('tags');
	box.replaceChildren(...(e ? autoOnly(e) : []).map(autoChip));
	for (const t of tags) {
		const c = document.createElement('span');
		c.className = 'chip tag';
		c.textContent = t;
		const x = document.createElement('button');
		x.className = 'tag-x';
		x.textContent = '×';
		x.title = `Remove tag "${t}"`;
		x.onclick = () => saveMeta({ tags: tags.filter((o) => o !== t) });
		c.append(x);
		box.append(c);
	}
	if (document.activeElement !== $('note')) $('note').value = e?.note || '';
	$('meta-status').textContent = '';
}

// Saves go to the server one at a time, in order. Each change is applied to the list at once and
// remembered in metaWant until it is stored, so a second edit made while the first is still on its
// way (note typed, then a tag's × clicked) builds on the first instead of undoing it.
const metaWant = new Map(); // "<dir>/<id>" -> { note, tags } not yet confirmed by the server
let metaQueue = Promise.resolve();

function applyWanted() {
	for (const [key, want] of metaWant) {
		const e = list.find((a) => `${a.dir}/${a.id}` === key);
		if (e) Object.assign(e, want);
	}
}

function metaShown() {
	fillFilters();
	fillTagList();
	renderList();
	showMeta();
}

function saveMeta(change) {
	const e = listEntry();
	if (!e) return;
	const key = `${e.dir}/${e.id}`;
	const want = { note: e.note || '', tags: e.tags || [], ...change };
	metaWant.set(key, want);
	Object.assign(e, want);
	metaShown();
	$('meta-status').textContent = 'Saving…';
	metaQueue = metaQueue.then(() => postMeta(key));
}

async function postMeta(key) {
	const want = metaWant.get(key);
	if (!want) return; // a later save already sent this attempt's newest state
	const [dir, id] = key.split('/');
	let res;
	try {
		res = await fetch(`/api/meta/${encodeURIComponent(dir)}/${encodeURIComponent(id)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(want)
		});
	} catch {
		res = null;
	}
	const isOpen = () => cur && `${cur.head.dir}/${cur.head.id}` === key;
	if (!res || !res.ok) {
		metaWant.delete(key);
		await loadList(); // show what the server really has
		if (isOpen()) showMeta();
		if (isOpen()) $('meta-status').textContent = res && res.status === 404 ? 'Not saved: restart the viewer (new route)' : 'Not saved';
		return;
	}
	const saved = await res.json();
	if (metaWant.get(key) !== want) return; // changed again meanwhile: that save is queued
	metaWant.delete(key);
	const now = list.find((a) => `${a.dir}/${a.id}` === key);
	if (now) Object.assign(now, saved);
	metaShown();
	if (isOpen()) $('meta-status').textContent = 'Saved';
}

function addTag() {
	const t = $('tag-add').value.trim();
	if (!t) return;
	$('tag-add').value = '';
	const tags = listEntry()?.tags || [];
	// a tag another attempt already has keeps that spelling, so the tag filter finds both
	const known = list.flatMap((a) => a.tags || []).find((o) => o.toLowerCase() === t.toLowerCase());
	if (!tags.some((o) => o.toLowerCase() === t.toLowerCase())) saveMeta({ tags: [...tags, known || t] });
}

function markSelected() {
	const key = cur ? `${cur.head.dir}/${cur.head.id}` : '';
	for (const b of document.querySelectorAll('.att')) b.classList.toggle('sel', b.dataset.key === key);
}

async function open(dir, id) {
	const res = await fetch(`/api/attempt/${encodeURIComponent(dir)}/${encodeURIComponent(id)}`);
	if (!res.ok) return;
	const a = await res.json();
	a.dir = dir;
	const d = parse(a);
	const { jumps, j1 } = findJumps(d, a.preRows);
	// runEnd(), not just before the post tail: a replay pauses at its end and keeps sending rows
	cur = { head: a, d, jumps, j1, tps: Math.round(1 / a.interval), endIdx: runEnd(a, d) };
	cur.stats = summarize(a, d, jumps);
	pathView = null;
	cur.path = recordingPath(a, d, jumps, cur.endIdx);
	location.hash = `${dir}/${id}`;
	showCm360();
	hoverIdx = -1;
	selMistake = null;
	fillCompare();
	await setGhostSafe();
	showHead();
	showMeta();
	renderList(); // lists it even when the filters or the drill toggle hide it
	findMistakes();
	whole();
}

// ---------- compare (ghost) ----------

const mapKey = (h) => `${h.dir}|${h.interval}`;

function loadChoices() {
	try {
		return JSON.parse(localStorage.getItem(CMP_KEY)) || {};
	} catch {
		return {};
	}
}

// Recordings the open attempt can be compared with: same map and tickrate (ticks wouldn't line up
// otherwise), not itself, no replay fragments
function candidates() {
	if (!cur) return [];
	const k = mapKey(cur.head);
	return list.filter((h) => mapKey(h) === k && h.id !== cur.head.id && !isFragment(h));
}

// The picks that follow the saved attempts: each resolves to one recording, or null
function presets(cands) {
	const own = cands.filter((h) => !isOther(h));
	const reps = cands.filter((h) => isOther(h));
	const minBy = (hs, f) => hs.reduce((b, h) => (Number.isFinite(f(h)) && (!b || f(h) < f(b)) ? h : b), null);
	const fin = (h) => (h.reason === 'finish' && h.runTime ? h.runTime : NaN);
	// A replay recording can stop before the run's end (its runTime is then short), so only replays that
	// got within 75 % of the longest replay time count, and the shortest of those wins
	const longest = Math.max(0, ...reps.map((h) => h.runTime || 0));
	const topRep = minBy(reps, (h) => (h.runTime >= 0.75 * longest ? h.runTime : NaN));
	return [
		{ id: 'p:fastest', name: 'Your fastest finish', h: minBy(own, fin), fact: (h) => `${h.runTime.toFixed(2)} s` },
		{ id: 'p:bestj1', name: 'Your best jump 1', h: minBy(own, (h) => (h.j1Land == null ? NaN : -h.j1Land)), fact: (h) => `lands ${h.j1Land.toFixed(0)} u/s` },
		{ id: 'p:replay', name: 'Top replay', h: topRep, fact: (h) => `${h.player || 'unknown player'}${h.runTime ? ` · ${h.runTime.toFixed(2)} s` : ''}` }
	];
}

function candText(h) {
	const kind = isDrill(h) ? `Drill · ${h.landed} jump${h.landed === 1 ? '' : 's'}` : labelText(h);
	const end = h.reason === 'finish' && h.runTime ? `${h.runTime.toFixed(2)} s` : REASONS[h.reason] || h.reason || '?';
	const j1 = h.j1Land == null ? '' : ` · jump 1 lands ${h.j1Land.toFixed(0)}`;
	return `${kind} · ${when(h.started)} · ${end}${j1}`;
}

function fillCompare() {
	const sel = $('cmp-sel');
	sel.replaceChildren(new Option('None', 'none'));
	if (!cur) return;
	const cands = candidates();
	for (const p of presets(cands)) {
		const o = new Option(p.h ? `${p.name}: ${p.fact(p.h)}` : `${p.name}: none saved`, p.id);
		o.disabled = !p.h;
		sel.append(o);
	}
	const grp = document.createElement('optgroup');
	grp.label = 'Pick one';
	for (const h of cands) grp.append(new Option(candText(h), `id:${h.id}`));
	sel.append(grp);
	const want = loadChoices()[mapKey(cur.head)] || 'none';
	sel.value = [...sel.options].some((o) => o.value === want && !o.disabled) ? want : 'none';
}

// The recording the picker points at, or null
function choiceHead() {
	const v = $('cmp-sel').value;
	const cands = candidates();
	if (v.startsWith('id:')) return cands.find((h) => h.id === v.slice(3)) || null;
	const p = presets(cands).find((x) => x.id === v);
	return p ? p.h : null;
}

async function setGhost() {
	const h = cur && choiceHead();
	if (!h) {
		ghost = null;
		return;
	}
	const key = `${h.dir}/${h.id}`;
	let g = ghostCache.get(key);
	if (!g) {
		const res = await fetch(`/api/attempt/${encodeURIComponent(h.dir)}/${encodeURIComponent(h.id)}`);
		if (!res.ok) {
			ghost = null;
			return;
		}
		const a = await res.json();
		a.dir = h.dir;
		const d = parse(a);
		const jumps = findJumps(d, a.preRows).jumps;
		// from the recording's own rows: the aligned copy's gaps would bend the path
		g = { head: a, d, jumps, path: recordingPath(a, d, jumps, runEnd(a, d)), stats: summarize(a, d, jumps) };
		ghostCache.set(key, g);
	}
	const al = alignGhost(cur, g, $('align').value);
	const gd = Object.assign({}, g.d, { x: al.x, gap: al.gap });
	const order = [];
	for (let i = 0; i < gd.n; i++) if (Number.isFinite(gd.x[i])) order.push(i);
	const v = $('cmp-sel').value;
	const how = v.startsWith('p:') ? presets(candidates()).find((p) => p.id === v).name : 'picked';
	// the path in the open attempt's turn, so both share one frame
	const path = turnPath(g.path, cur.path.turn);
	ghost = { key, head: g.head, d: g.d, jumps: g.jumps, gd, order, mode: al.mode, matched: al.matched, how, path, stats: g.stats, ownPath: g.path };
}

// A ghost that fails to load must not stop the open attempt from showing
async function setGhostSafe() {
	try {
		await setGhost();
	} catch (e) {
		console.error('ghost not loaded', e);
		ghost = null;
	}
}

async function compareChanged() {
	if (!cur) return;
	const ch = loadChoices();
	ch[mapKey(cur.head)] = $('cmp-sel').value;
	localStorage.setItem(CMP_KEY, JSON.stringify(ch));
	localStorage.setItem(ALIGN_KEY, $('align').value);
	await setGhostSafe();
	showHead();
	showRunStats();
	draw();
}

// ---------- mistakes ----------

function loadSettings() {
	try {
		return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
	} catch {
		return {};
	}
}

// Only values that differ from the defaults are stored, so changed defaults still reach old settings
function saveSetting(id, key, value, def) {
	const all = loadSettings();
	const c = (all[id] ||= {});
	if (value === def) delete c[key];
	else c[key] = value;
	if (!Object.keys(c).length) delete all[id];
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(all));
}

// Jump-1 takeoff median of the other own attempts on this map and tickrate (j1Takeoff from the server)
function takeoffBaseline(h) {
	const vs = list
		.filter((a) => a.dir === h.dir && a.interval === h.interval && !isOther(a) && a.id !== h.id && a.j1Takeoff >= MIN_TAKEOFF)
		.map((a) => a.j1Takeoff);
	return vs.length ? { takeoffMedian: median(vs), takeoffRuns: vs.length } : null;
}

function findMistakes() {
	if (!cur) return;
	// a spectated live player's per-tick speed is too coarse for the checks (see parse())
	cur.mistakes = cur.d.coarse ? [] : runChecks(cur.d, cur.jumps, cur.endIdx, loadSettings(), takeoffBaseline(cur.head), isOther(cur.head));
	if (selMistake && !cur.mistakes.some((m) => m.check === selMistake.check && m.i0 === selMistake.i0)) selMistake = null;
	showMistakes();
}

function showMistakes() {
	const box = $('mistakes-list');
	box.replaceChildren();
	const ms = cur ? cur.mistakes : [];
	const total = ms.reduce((t, m) => t + m.lost, 0);
	const skipped = cur && isOther(cur.head) ? " · key timing checks are skipped for other players' recordings (replay keys run ahead of the turn)" : '';
	if (cur && cur.d.coarse) {
		$('mistakes-sum').textContent = "Checks off: a spectated live player's speed only updates every few ticks, too coarse to judge ticks.";
		showRunStats();
		return;
	}
	$('mistakes-sum').textContent = cur ? `${ms.length} found · ranked by speed lost (sum of ideal - gain over the ticks involved), ${total.toFixed(0)} u/s in all${skipped}` : '';
	if (cur && !ms.length) box.textContent = 'No mistakes found with the current settings.';
	showRunStats();
	for (const m of ms) {
		const b = document.createElement('button');
		b.className = `mk${selMistake === m ? ' sel' : ''}`;
		const lost = document.createElement('span');
		lost.className = `lost${m.lost < 0.05 ? ' zero' : ''}`;
		lost.textContent = `${m.lost.toFixed(1)} u/s`;
		const name = document.createElement('span');
		name.className = 'name';
		name.textContent = m.name;
		const text = document.createElement('span');
		text.textContent = `${m.text} · tick ${cur.d.x[m.i0]}${m.i1 > m.i0 ? `–${cur.d.x[m.i1]}` : ''}`;
		b.append(lost, name, text);
		b.onclick = () => {
			selMistake = m;
			showMistakes();
			const j = cur.jumps.find((jj) => jj.num && jj.num === m.jump);
			// a mistake inside one jump zooms to that jump, a run-wide one (imbalance) to the whole run
			if (j && m.check !== 'balance') zoomTo({ x0: Math.min(j.x0, cur.d.x[m.i0]), x1: Math.max(j.x1, cur.d.x[m.i1]) });
			else whole();
			$('plot').scrollIntoView({ block: 'nearest' });
		};
		box.append(b);
	}
}

function showSettings() {
	const box = $('settings-list');
	box.replaceChildren();
	const saved = loadSettings();
	for (const c of CHECKS) {
		const s = saved[c.id] || {};
		const on = s.on === undefined ? c.on : s.on;
		const card = document.createElement('div');
		card.className = `ck${on ? '' : ' off'}`;
		const title = document.createElement('label');
		title.className = 'title';
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.checked = on;
		cb.onchange = () => {
			saveSetting(c.id, 'on', cb.checked, c.on);
			card.classList.toggle('off', !cb.checked);
			findMistakes();
			draw();
		};
		title.append(cb, document.createTextNode(c.name));
		const help = document.createElement('div');
		help.className = 'help';
		help.textContent = c.help;
		card.append(title, help);
		for (const [p, def] of Object.entries(c.params)) {
			const row = document.createElement('label');
			row.className = `param${s[p] !== undefined ? ' changed' : ''}`;
			const inp = document.createElement('input');
			inp.type = 'number';
			inp.step = 'any';
			inp.value = s[p] === undefined ? def.v : s[p];
			inp.title = `default ${def.v}`;
			inp.onchange = () => {
				const v = inp.value === '' ? def.v : +inp.value;
				if (!Number.isFinite(v)) return;
				inp.value = v;
				saveSetting(c.id, p, v, def.v);
				row.classList.toggle('changed', v !== def.v);
				findMistakes();
				draw();
			};
			const lab = document.createElement('span');
			lab.textContent = `${def.label} (default ${def.v})`;
			row.append(lab, inp);
			card.append(row);
		}
		box.append(card);
	}
}

function showHead() {
	const h = cur.head;
	const el = $('head');
	el.replaceChildren();
	const name = document.createElement('b');
	name.textContent = h.map;
	const facts = document.createElement('span');
	facts.className = 'muted';
	facts.textContent = [
		h.runTime ? `${h.runTime.toFixed(3)} s` : 'no run time',
		`${cur.tps} tick`,
		`${runGaps(h, cur.d)} missed ticks`,
		`style ${h.style}`,
		`${cur.jumps.filter((j) => j.num > 0).length} jumps`,
		when(h.started)
	].join(' · ');
	el.append(name, labelChip(h), reasonChip(h), facts);
	const note = (cls, text) => {
		const n = document.createElement('span');
		n.className = `chip ${cls}`;
		n.textContent = text;
		el.append(n);
	};
	if (cur.d.coarse) note('replay', 'Speed updates every few ticks (spectated live): gain per jump only, checks off');
	else if (cur.d.derived) note('replay', 'Gain and angle rebuilt from speed (no tick stats in this recording)');
	$('align-hint').hidden = !ghost; // only says something when there is a ghost to line up
	if (ghost) {
		const gh = ghost.head;
		const end = gh.reason === 'finish' && gh.runTime ? `${gh.runTime.toFixed(2)} s` : REASONS[gh.reason] || gh.reason || '?';
		const al =
			ghost.mode === 'jump'
				? `aligned per jump (${ghost.matched} matched)`
				: $('align').value === 'jump'
					? 'aligned on timer start (no jump in common)'
					: 'aligned on timer start';
		note('ghost', `Ghost (dashed pink): ${labelText(gh)} · ${ghost.how} · ${when(gh.started)} · ${end} · ${al}`);
		if (ghost.d.derived && !cur.d.derived) note('ghost', 'Ghost gain and angle rebuilt from speed');
		if (isOther(gh)) note('ghost', 'Ghost keys not drawn: replay keys run ahead of the angles');
	}
}

// ---------- run stats ----------

// Whole-run numbers above the graph, from summarize() (stats.js) so the compare page agrees. With a
// ghost, its value sits next to each one in pink (not for rows with ghost: false). need: 'tick' rows are left out for a spectated live
// run (speed only every few ticks), 'keys' rows for other players' recordings (their keys run ahead).
function runStatRows() {
	const n = (v, k = 1, unit = '') => (Number.isFinite(v) ? `${v.toFixed(k)}${unit}` : '–');
	const endOf = (h) => (h.reason === 'finish' && h.runTime ? `${h.runTime.toFixed(3)} s` : REASONS[h.reason] || h.reason || '?');
	const jumpOf = (r, j) => (j ? `jump ${j.num} · ${n(j.pct, 2, ' %')}` : '–');
	const swapOf = (r, w) => (w ? `jump ${w.jump} swap ${w.k}${w.btn ? ' (+left/right)' : ''} · ${n(w.lost, 1, ' u/s')}` : '–');
	const zoomJump = (num) => {
		const j = cur.jumps.find((jj) => jj.num === num);
		if (j) zoomTo(j);
	};
	const cms = (r, deg) => {
		const m = mouseFor(r.head, mouseNow, dpi);
		return m && Number.isFinite(deg) ? ` · ${cmPerSec(deg, r.head.interval, m).toFixed(1)} cm/s` : '';
	};
	return [
		{
			title: 'Run',
			rows: [
				{ name: 'End', tip: 'Finish time, or how the attempt ended', v: (s, r) => endOf(r.head) },
				{ name: 'Jumps landed', tip: 'Jumps from jump 1 on that landed before the run end', v: (s) => `${s.landed} of ${s.jumps}` },
				{ name: 'Missed ticks', tip: 'Ticks the HUD missed inside the run (frames slower than ticks)', v: (s, r) => String(runGaps(r.head, r.d)) },
				{ name: 'Distance', tip: 'Horizontal distance from the timer start to the run end, built up from speed (teleports add nothing)', v: (s, r) => `${Math.round(pathDistance(r.path, Math.min(r.head.preRows || 0, r.d.n - 1), s.endIdx))} u` },
				{ name: 'Air time', tip: 'Share of the run ticks in the air (vz not 0)', v: (s) => n(s.airPct, 1, ' %'), need: 'tick' }
			]
		},
		{
			title: 'Gain',
			rows: [
				{ name: 'Gain %', tip: 'Sum of gain over sum of ideal gain, every jump from jump 1 on (as the jump strip)', v: (s) => n(s.gainPct, 2, ' %') },
				{ name: 'Speed lost', tip: 'Sum of ideal - gain over every strafing tick (air, 100+ u/s, no wall hit): speed you could have had', v: (s) => n(s.lost, 0, ' u/s'), need: 'tick' },
				{ name: 'Best jump', tip: 'Landed jump with the highest gain %', v: (s, r) => jumpOf(r, s.bestJump), click: (s) => s.bestJump && zoomJump(s.bestJump.num) },
				{ name: 'Worst jump', tip: 'Landed jump with the lowest gain %', v: (s, r) => jumpOf(r, s.worstJump), click: (s) => s.worstJump && zoomJump(s.worstJump.num) },
				{ name: 'Spread', tip: 'Standard deviation of the landed jumps\' gain %: lower = more even jump to jump', v: (s) => n(s.spread, 1, ' %') },
				{ name: 'Left / right', tip: 'Gain % on ticks turning left (A side) and turning right (D side)', v: (s) => `${n(s.leftPct, 1)} / ${n(s.rightPct, 1)} %`, need: 'tick' }
			]
		},
		{
			title: 'Speed',
			rows: [
				{ name: 'Max', v: (s) => n(s.speedMax, 0, ' u/s') },
				{ name: 'Average', tip: 'Horizontal speed averaged over the run ticks', v: (s) => n(s.speedAvg, 0, ' u/s') },
				{ name: 'At the end', tip: 'At the finish, or at the end of the recording', v: (s) => n(s.speedEnd, 0, ' u/s') },
				{ name: 'Jump 1 takeoff', v: (s) => (s.j1 ? n(s.j1.takeoff, 1, ' u/s') : '–') },
				{ name: 'Jump 1 landing', v: (s) => (s.j1 && s.j1.landed ? n(s.j1.land, 1, ' u/s') : '–') },
				{ name: 'Jump 1 gain', v: (s) => (s.j1 ? n(s.j1.pct, 2, ' %') : '–'), click: () => zoomJump(1) }
			]
		},
		{
			title: 'Turning',
			rows: [
				{ name: 'Angle (yawRatio)', tip: 'Median yawRatio of strafe middles (2 ticks skipped at each end, +left/+right ticks out). 1 = optimal', v: (s) => n(s.angle, 2), need: 'tick' },
				{ name: 'In optimal band', tip: `Strafe-middle ticks at yawRatio ${BAND_LO}-${BAND_HI} (the yaw lane's band)`, v: (s) => n(s.inBand, 1, ' %'), need: 'tick' },
				{ name: 'Too slow / too fast', tip: `Strafe-middle ticks under ${BAND_LO} / over ${BAND_HI}`, v: (s) => `${n(s.tooSlow, 1)} / ${n(s.tooFast, 1)} %`, need: 'tick' },
				{ name: 'Turn speed', tip: 'Median turn speed of strafe middles (5-tick average), and in mouse terms when the DPI is set (a replay at your sens)', v: (s, r) => `${n(s.yawMid, 2, '°/t')}${cms(r, s.yawMid)}`, need: 'tick' },
				{ name: 'Strafes per jump', tip: 'Turns to one side per landed jump', v: (s) => n(s.strafesPerJump, 1), need: 'tick' },
				{ name: 'Strafe length', tip: 'Median ticks of one strafe (one turn to one side)', v: (s) => n(s.strafeLen, 0, ' t'), need: 'tick' },
				{ name: 'Air time turning', tip: 'Strafing ticks with a turn of more than 0.3°/tick', v: (s) => n(s.turnPct, 1, ' %'), need: 'tick' },
				{ name: '+left/+right ticks', tip: 'Strafing ticks with a turn button held (fixed cl_yawspeed turn, left out of the angle numbers)', v: (s) => String(s.btnTicks), need: 'tick' }
			]
		},
		{
			title: 'Swaps (strafe direction changes)',
			rows: [
				{ name: 'Swaps', tip: 'Strafe direction changes inside jumps, without missed ticks near them', v: (s) => String(s.swaps.length), need: 'tick' },
				{ name: 'Swap time', tip: 'Median ticks from the last tick turning at 85 %+ of optimal one way to the first one the other way', v: (s) => n(s.swapTime, 1, ' t'), need: 'tick' },
				{ name: 'Swap efficiency', tip: 'Median gain % of ideal over the 7 ticks centred on each reversal', v: (s) => n(s.swapEff, 1, ' %'), need: 'tick' },
				{ name: 'Lost at swaps', tip: 'Ideal - gain summed over those 7-tick windows, and its share of all speed lost', v: (s) => `${n(s.swapLost, 0, ' u/s')} · ${n(s.swapLostShare, 0, ' %')}`, need: 'tick' },
				{ name: 'Peak after swap', tip: `Median of the fastest 2-tick turn in the 6 ticks after each reversal, vs optimal (100 % = optimal). +left/+right swaps not judged`, v: (s) => n(100 * s.peak, 0, ' %'), need: 'tick' },
				{ name: 'Over / undershoot', tip: `Swaps whose peak is over ${BAND_HI * 100} % / under ${BAND_LO * 100} % of optimal, of the swaps judged`, v: (s) => `${s.over} / ${s.under} of ${s.judged}`, need: 'tick' },
				{ name: 'Worst swap', tip: 'The swap with the most speed lost in its 7-tick window. (+left/right): a turn button was held, e.g. the prestrafe into jump 1', v: (s, r) => swapOf(r, s.worstSwap), click: (s) => s.worstSwap && zoomTo({ x0: cur.d.x[s.worstSwap.i] - 25, x1: cur.d.x[s.worstSwap.i] + 25 }), need: 'tick' }
			]
		},
		{
			title: 'Keys',
			rows: [
				{
					name: 'Sync (keys vs turn)',
					tip: "Strafing ticks where A or D alone matches the turn side, keys shifted by the best lag. +left/+right ticks out. Not the game's sync number",
					v: (s, r) => `${n(s.sync, 1, ' %')}${isOther(r.head) ? ' approx.' : ''}`,
					need: 'tick'
				},
				{ name: 'Key lag', tip: 'Ticks the keys run ahead of the turn (best match). Own runs about 1, replays 5-7', v: (s) => `${s.lag} t`, need: 'tick' },
				{ name: 'Switch vs reversal', tip: 'Median ticks from the key switch to the reversal, as the switch check (target -1: one tick before)', v: (s) => n(s.keyOff, 1, ' t'), need: 'keys' },
				{ name: 'Switch on target', tip: 'Switches 0-2 ticks before the reversal', v: (s) => n(s.keyOnTarget, 0, ' %'), need: 'keys' },
				{ name: 'Early / late', tip: 'Switches 3+ ticks before / after the reversal', v: (s) => `${s.keyEarly} / ${s.keyLate}`, need: 'keys' },
				{ name: 'No key while turning', tip: 'Turning strafing ticks with neither or both of A and D (+left/+right ticks out)', v: (s) => n(s.noKeyPct, 1, ' %'), need: 'keys' },
				{ name: 'W in the air', tip: 'Strafing ticks with W held', v: (s) => n(s.wAirPct, 1, ' %'), need: 'keys' }
			]
		},
		{
			title: 'Mistakes',
			rows: [
				{ name: 'Found', tip: 'Mistake checks with the current settings (list below the path)', v: (s, r) => (r.mistakes ? String(r.mistakes.length) : '–'), need: 'tick', ghost: false },
				{ name: 'Speed lost to them', v: (s, r) => (r.mistakes ? n(r.mistakes.reduce((a, m) => a + m.lost, 0), 1, ' u/s') : '–'), need: 'tick', ghost: false }
			]
		}
	];
}

function showRunStats() {
	const sec = $('run-stats');
	sec.hidden = !cur;
	if (!cur) return;
	const box = $('rs-body');
	box.replaceChildren();
	box.classList.toggle('with-ghost', !!ghost);
	const me = { head: cur.head, d: cur.d, path: cur.path, mistakes: cur.mistakes };
	const gh = ghost && { head: ghost.head, d: ghost.d, path: ghost.ownPath, mistakes: null };
	const skip = (r, need) => (need === 'tick' && r.d.coarse) || (need === 'keys' && (r.d.coarse || isOther(r.head)));
	const why = (r) => (r.d.coarse ? 'spectated: speed every few ticks' : 'not run (replay keys run ahead)');
	const notes = [];
	if (cur.d.coarse) notes.push("Spectated live run: speed only updates every few ticks, so only run, gain and speed numbers are shown.");
	else if (isOther(cur.head)) notes.push("Other player's recording: key numbers are left out (replay keys run ahead of the angles).");
	if (gh) notes.push(`Pink: the Compare recording (${labelText(gh.head)}).`);
	$('rs-note').textContent = notes.join(' ');
	for (const card of runStatRows()) {
		const c = document.createElement('div');
		c.className = 'rs-card';
		const h = document.createElement('h3');
		h.textContent = card.title;
		c.append(h);
		if (card.rows.every((row) => skip(me, row.need)) && !(gh && card.rows.some((row) => !skip(gh, row.need)))) {
			const off = document.createElement('div');
			off.className = 'rs-off';
			off.textContent = `Not shown: ${why(me)}`;
			c.append(off);
			box.append(c);
			continue;
		}
		for (const row of card.rows) {
			const el = document.createElement('div');
			el.className = 'rs-row';
			const name = document.createElement('span');
			name.className = 'rs-name';
			name.textContent = row.name;
			if (row.tip) name.title = row.tip;
			const val = document.createElement('span');
			val.className = 'rs-val';
			if (skip(me, row.need)) {
				val.textContent = '–';
				val.title = why(me);
			} else {
				val.textContent = row.v(cur.stats, me);
				if (row.click) {
					val.classList.add('rs-link');
					val.onclick = () => {
						row.click(cur.stats);
						$('plot').scrollIntoView({ block: 'nearest' });
					};
				}
			}
			el.append(name, val);
			if (gh) {
				const g = document.createElement('span');
				g.className = 'rs-ghost';
				g.textContent = skip(gh, row.need) || row.ghost === false ? '–' : row.v(ghost.stats, gh);
				el.append(g);
			}
			c.append(el);
		}
		box.append(c);
	}
}

// ---------- view ----------

function fullRange() {
	const d = cur.d;
	return { x0: d.x[0] - 5, x1: d.x[d.n - 1] + 5 };
}

function whole() {
	if (!cur) return;
	view = fullRange();
	draw();
}

function zoomTo(j) {
	const pad = Math.max(10, (j.x1 - j.x0) * 0.08);
	view = { x0: j.x0 - pad, x1: j.x1 + pad };
	draw();
}

function plotW() {
	return base.clientWidth - GUTTER - RIGHT_PAD;
}

function px(x) {
	return GUTTER + ((x - view.x0) / (view.x1 - view.x0)) * plotW();
}

function xAt(pxv) {
	return view.x0 + ((pxv - GUTTER) / plotW()) * (view.x1 - view.x0);
}

function nearest(x) {
	const d = cur.d;
	let lo = 0;
	let hi = d.n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (d.x[mid] < x) lo = mid;
		else hi = mid;
	}
	return Math.abs(d.x[lo] - x) <= Math.abs(d.x[hi] - x) ? lo : hi;
}

function layout() {
	let y = 0;
	for (const l of LANES) {
		l.y = y;
		y += l.h + LANE_GAP;
	}
	return y + AXIS_H;
}

function size(cv, w, h) {
	const r = window.devicePixelRatio || 1;
	cv.width = Math.round(w * r);
	cv.height = Math.round(h * r);
	cv.style.width = `${w}px`;
	cv.style.height = `${h}px`;
	const g = cv.getContext('2d');
	g.setTransform(r, 0, 0, r, 0, 0);
	return g;
}

function niceStep(span, pxWidth, minPx) {
	const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000];
	for (const s of steps) if ((s / span) * pxWidth >= minPx) return s;
	return steps[steps.length - 1];
}

// ---------- drawing ----------

function draw() {
	const W = $('plot').clientWidth;
	const H = layout();
	$('plot').style.height = `${H}px`;
	const g = size(base, W, H);
	size(over, W, H);
	g.font = '12px system-ui, sans-serif';
	drawPath();
	if (!cur) return;
	const d = cur.d;
	const i0 = Math.max(0, nearest(view.x0) - 1);
	const i1 = Math.min(d.n - 1, nearest(view.x1) + 1);
	const tickPx = plotW() / (view.x1 - view.x0);

	const step = niceStep(view.x1 - view.x0, plotW(), 80);
	const gridStart = Math.ceil(view.x0 / step) * step;

	for (const l of LANES) {
		g.fillStyle = COL.card;
		g.fillRect(GUTTER, l.y, plotW(), l.h);
		g.fillStyle = COL.text;
		g.font = '600 13px system-ui, sans-serif';
		g.fillText(l.title, 8, l.y + 16);
		g.font = '11px system-ui, sans-serif';
		g.fillStyle = COL.muted;
		if (l.sub && l.h > 30) g.fillText(l.sub, 8, l.y + 31);
		g.save();
		g.beginPath();
		g.rect(GUTTER, l.y, plotW(), l.h);
		g.clip();
		// start zone, after the end, ground ticks, grid
		g.fillStyle = COL.pre;
		g.fillRect(GUTTER, l.y, px(-0.5) - GUTTER, l.h);
		if (cur.endIdx < d.n - 1) {
			g.fillStyle = COL.post;
			const xe = px(d.x[cur.endIdx] + 0.5);
			g.fillRect(xe, l.y, W, l.h);
		}
		if (l.id !== 'jumps' && l.id !== 'gaps') {
			g.fillStyle = COL.ground;
			for (let i = i0; i <= i1; i++) if (d.ground[i]) g.fillRect(px(d.x[i] - 0.5), l.y, Math.max(tickPx, 1), l.h);
		}
		g.strokeStyle = COL.grid;
		g.lineWidth = 1;
		g.beginPath();
		for (let x = gridStart; x <= view.x1; x += step) {
			const X = Math.round(px(x)) + 0.5;
			g.moveTo(X, l.y);
			g.lineTo(X, l.y + l.h);
		}
		g.stroke();
		gutterText = [];
		LANE_DRAW[l.id](g, l, d, i0, i1, tickPx);
		g.restore();
		g.fillStyle = COL.muted;
		g.font = '11px system-ui, sans-serif';
		g.textAlign = 'right';
		for (const [text, y] of gutterText) g.fillText(text, GUTTER - 6, y);
		g.textAlign = 'left';
		g.strokeStyle = COL.border;
		g.lineWidth = 1;
		g.strokeRect(GUTTER + 0.5, l.y + 0.5, plotW() - 1, l.h - 1);
	}

	// x axis: ticks from the timer start, with seconds
	const ay = LANES[LANES.length - 1].y + LANES[LANES.length - 1].h + 4;
	g.fillStyle = COL.muted;
	g.font = '11px system-ui, sans-serif';
	g.textAlign = 'center';
	for (let x = gridStart; x <= view.x1; x += step) {
		if (px(x) < GUTTER + 40) continue;
		g.fillText(`${x}  (${(x / cur.tps).toFixed(2)} s)`, px(x), ay + 12);
	}
	g.textAlign = 'left';
	g.fillText('tick from timer start', 8, ay + 12);
	drawHover();
}

function yMap(l, lo, hi) {
	const top = l.y + 6;
	const bot = l.y + l.h - 6;
	return (v) => bot - ((v - lo) / (hi - lo || 1)) * (bot - top);
}

function yLabels(l, Y, values, fmt) {
	const used = [];
	for (const v of values) {
		const y = Math.min(Math.max(Y(v) + 4, l.y + 44), l.y + l.h - 2);
		if (used.some((u) => Math.abs(u - y) < 12)) continue;
		used.push(y);
		gutterText.push([fmt(v), y]);
	}
}

// A line through rows that pass `ok`, broken at missed ticks and at rows that fail
function line(g, d, i0, i1, val, Y, color, width, ok = () => true) {
	g.strokeStyle = color;
	g.lineWidth = width;
	g.beginPath();
	let pen = false;
	for (let i = i0; i <= i1; i++) {
		const v = val(i);
		if (!Number.isFinite(v) || !Number.isFinite(d.x[i]) || !ok(i)) {
			pen = false;
			continue;
		}
		if (d.gap[i] > 0) pen = false; // start a new piece after missed ticks
		const X = px(d.x[i]);
		const yv = Y(v);
		if (pen) g.lineTo(X, yv);
		else g.moveTo(X, yv);
		pen = true;
	}
	g.stroke();
}

// q-th fraction of the finite values, so one teleport or slow tick doesn't squash the lane
function quantile(d, i0, i1, val, q) {
	const vs = [];
	for (let i = i0; i <= i1; i++) {
		const v = val(i);
		if (Number.isFinite(v)) vs.push(v);
	}
	if (!vs.length) return NaN;
	vs.sort((a, b) => a - b);
	return vs[Math.min(vs.length - 1, Math.floor(q * vs.length))];
}

function minOf(d, i0, i1, val) {
	let m = Infinity;
	for (let i = i0; i <= i1; i++) {
		const v = val(i);
		if (Number.isFinite(v) && v < m) m = v;
	}
	return m;
}

const air = (d) => (i) => !d.ground[i];
// Scales come from strafing rows only: in the air at 100+ u/s (falling at near-zero speed has ideal gain near 30)
const strafingRows = (d) => (i) => !d.ground[i] && d.speed[i] > 100;

// The ghost's line in a lane: dashed, over all its rows (the lane clip drops what is off screen)
function ghostLine(g, val, Y, ok) {
	if (!ghost) return;
	g.setLineDash([6, 4]);
	line(g, ghost.gd, 0, ghost.gd.n - 1, val, Y, COL.ghost, 1.5, ok && ok(ghost.gd));
	g.setLineDash([]);
}

// Yaw speed with its direction (up = left turn, as the drill page): the optimal and its band sit on
// the side the turn needs, one line per side, so a strafe change is a gap and not a slope
function yawSigned(g, l, d, i0, i1, hi) {
	const Y = yMap(l, -hi, hi);
	g.strokeStyle = '#5a6478';
	g.lineWidth = 1;
	g.beginPath();
	g.moveTo(GUTTER, Y(0));
	g.lineTo(base.clientWidth, Y(0));
	g.stroke();
	g.fillStyle = COL.band;
	for (let i = i0; i <= i1; i++) {
		const o = d.opt[i];
		const s = d.ideal_key[i];
		if (!Number.isFinite(o) || !s) continue;
		const y1 = Y(s * o * 1.15);
		const y2 = Y(s * o * 0.85);
		g.fillRect(px(d.x[i] - 0.5), Math.min(y1, y2), Math.max(px(d.x[i] + 0.5) - px(d.x[i] - 0.5), 1), Math.abs(y2 - y1));
	}
	line(g, d, i0, i1, (i) => d.yawd[i], Y, COL.raw, 1);
	ghostLine(g, (i) => ghost.gd.yaws[i], Y, air);
	for (const side of [1, -1]) line(g, d, i0, i1, (i) => side * d.opt[i], Y, COL.opt, 1.5, (i) => d.ideal_key[i] === side);
	line(g, d, i0, i1, (i) => d.yaws[i], Y, COL.line, 2, air(d));
	yLabels(l, Y, [hi, hi / 2, 0, -hi / 2, -hi], (v) => v.toFixed(1));
}

const LANE_DRAW = {
	jumps(g, l, d) {
		g.font = '600 12px system-ui, sans-serif';
		for (const j of cur.jumps) {
			const X0 = px(j.x0 - 0.5);
			const X1 = px(j.x1 + 0.5);
			if (X1 < GUTTER || X0 > base.clientWidth) continue;
			const t = Math.min(Math.max((j.pct - 60) / 35, 0), 1); // 60% red .. 95% green
			const hue = 0 + t * 120;
			g.fillStyle = j.num ? `hsl(${hue} 55% 38%)` : '#3a4152';
			g.fillRect(X0 + 1, l.y + 4, X1 - X0 - 2, l.h - 8);
			g.strokeStyle = j.num ? `hsl(${hue} 65% 62%)` : COL.border;
			g.strokeRect(X0 + 1.5, l.y + 4.5, X1 - X0 - 3, l.h - 9);
			const label = `${j.num ? j.num : 'pre'} · ${Number.isFinite(j.pct) ? j.pct.toFixed(2) : '?'}%`;
			const gj = ghost && j.num ? ghost.jumps.find((x) => x.num === j.num) : null;
			const full = gj && Number.isFinite(gj.pct) ? `${label} · ghost ${gj.pct.toFixed(2)}%` : label;
			for (const t of [full, label]) {
				if (g.measureText(t).width >= X1 - X0 - 8) continue;
				g.fillStyle = COL.text;
				g.fillText(t, X0 + 6, l.y + l.h / 2 + 4);
				break;
			}
		}
		// the ghost's jumps: a pink bar along the bottom of the strip, where its air time sits
		if (ghost) {
			g.fillStyle = COL.ghost;
			for (const j of ghost.jumps) {
				if (!j.num) continue;
				let a = NaN;
				let b = NaN;
				for (let i = j.s; i < j.e; i++) {
					const x = ghost.gd.x[i];
					if (!Number.isFinite(x)) continue;
					if (!Number.isFinite(a)) a = x;
					b = x;
				}
				if (Number.isFinite(a)) g.fillRect(px(a - 0.5) + 1, l.y + l.h - 7, px(b + 0.5) - px(a - 0.5) - 2, 3);
			}
		}
		if (px(0) > GUTTER) {
			g.fillStyle = COL.muted;
			g.font = '11px system-ui, sans-serif';
			g.fillText('start zone', GUTTER + 4, l.y + 12);
		}
	},

	yaw(g, l, d, i0, i1) {
		const ok = strafingRows(d);
		// scales to the ticks in view: the optimal falls as speed rises, so a whole-attempt scale (set by the
		// slow start) squashes the late, fast jumps; the band keeps each jump readable on its own
		const optMax = quantile(d, i0, i1, (i) => (ok(i) ? d.opt[i] : NaN), 0.98);
		const hi = Number.isFinite(optMax) ? optMax * 2.2 : Math.max(1, quantile(d, i0, i1, (i) => Math.abs(d.yawd[i]), 0.98));
		// signed, each side has half the lane, so the scale is tighter (raw spikes past it are clipped)
		if ($('yaw-signed').checked) return yawSigned(g, l, d, i0, i1, hi / 1.6);
		const Y = yMap(l, 0, hi);
		// optimal band, 85-115 %
		g.fillStyle = COL.band;
		for (let i = i0; i <= i1; i++) {
			const o = d.opt[i];
			if (!Number.isFinite(o)) continue;
			g.fillRect(px(d.x[i] - 0.5), Y(o * 1.15), Math.max(px(d.x[i] + 0.5) - px(d.x[i] - 0.5), 1), Y(o * 0.85) - Y(o * 1.15));
		}
		line(g, d, i0, i1, (i) => Math.abs(d.yawd[i]), Y, COL.raw, 1);
		ghostLine(g, (i) => Math.abs(ghost.gd.yaws[i]), Y, air);
		line(g, d, i0, i1, (i) => d.opt[i], Y, COL.opt, 1.5);
		line(g, d, i0, i1, (i) => Math.abs(d.yaws[i]), Y, COL.line, 2, air(d));
		yLabels(l, Y, [0, hi / 2, hi], (v) => v.toFixed(1));
	},

	ratio(g, l, d, i0, i1, tickPx) {
		const Y = yMap(l, 0, 2);
		g.fillStyle = COL.band;
		g.fillRect(GUTTER, Y(1.15), plotW(), Y(0.85) - Y(1.15));
		for (let i = i0; i <= i1; i++) {
			const r = d.ratio[i];
			if (d.ground[i] || !Number.isFinite(r)) continue;
			const c = Math.min(Math.max(r, 0), 2);
			g.fillStyle = c > 1 ? COL.wide : COL.narrow;
			const y0 = Y(1);
			const y1 = Y(c);
			g.fillRect(px(d.x[i] - 0.5), Math.min(y0, y1), Math.max(tickPx, 1), Math.abs(y1 - y0));
		}
		ghostLine(g, (i) => Math.min(ghost.gd.ratio[i], 2), Y, air);
		g.strokeStyle = COL.opt;
		g.lineWidth = 1.5;
		g.beginPath();
		g.moveTo(GUTTER, Y(1));
		g.lineTo(base.clientWidth, Y(1));
		g.stroke();
		yLabels(l, Y, [0, 1, 2], (v) => (v === 2 ? '≥2' : String(v)));
		g.fillStyle = COL.muted;
		g.fillText('too wide', GUTTER + 6, l.y + 14);
		g.fillText('too narrow', GUTTER + 6, l.y + l.h - 6);
	},

	gain(g, l, d, i0, i1) {
		if (d.coarse) {
			g.fillStyle = COL.muted;
			g.fillText('Per-tick gain hidden: a spectated live player\'s speed only updates every few ticks. Per-jump % is in the Jumps lane.', GUTTER + 8, l.y + l.h / 2);
			return;
		}
		const isAir = air(d);
		const ok = strafingRows(d);
		// unlike the other lanes, gain scales to the ticks in view (owner's pick)
		const hi = Math.max(0.1, quantile(d, i0, i1, (i) => (ok(i) ? Math.max(d.ideal[i], d.gain[i]) : NaN), 0.98) * 1.1);
		const lo = Math.max(-hi, Math.min(0, minOf(d, i0, i1, (i) => (ok(i) ? d.gain[i] : NaN))));
		const Y = yMap(l, lo, hi);
		// lost gain, shaded between the gain and ideal lines: one piece per tick step, cut where they cross
		g.fillStyle = COL.loss;
		g.beginPath();
		for (let i = Math.max(1, i0); i <= i1; i++) {
			if (!isAir(i) || !isAir(i - 1) || d.gap[i] > 0) continue;
			const a = d.ideal[i - 1] - d.gain[i - 1];
			const b = d.ideal[i] - d.gain[i];
			if (!Number.isFinite(a) || !Number.isFinite(b) || (a <= 0 && b <= 0)) continue;
			const xa = d.x[i - 1];
			const xb = d.x[i];
			// the part of the step where gain is under ideal: [ta, tb] of the way from i-1 to i
			const tc = a / (a - b);
			const ta = a > 0 ? 0 : tc;
			const tb = b > 0 ? 1 : tc;
			const at = (arr, t) => arr[i - 1] + (arr[i] - arr[i - 1]) * t;
			const X = (t) => px(xa + (xb - xa) * t);
			g.moveTo(X(ta), Y(at(d.ideal, ta)));
			g.lineTo(X(tb), Y(at(d.ideal, tb)));
			g.lineTo(X(tb), Y(at(d.gain, tb)));
			g.lineTo(X(ta), Y(at(d.gain, ta)));
			g.closePath();
		}
		g.fill();
		// ideal in light grey, not the usual green: the gain line itself goes red to green
		line(g, d, i0, i1, (i) => d.ideal[i], Y, COL.idealGain, 1.5, isAir);
		if (!ghost?.gd.coarse) ghostLine(g, (i) => ghost.gd.gain[i], Y, air);
		// gain, each tick step coloured by the 5-tick gain % of ideal (the path's colour)
		const pct = cur.path.pct;
		g.lineWidth = 2.5;
		g.lineCap = 'round';
		for (let i = Math.max(1, i0); i <= i1; i++) {
			if (!isAir(i) || !isAir(i - 1) || d.gap[i] > 0) continue;
			if (!Number.isFinite(d.gain[i]) || !Number.isFinite(d.gain[i - 1])) continue;
			g.strokeStyle = gainColor(pct[i]);
			g.beginPath();
			g.moveTo(px(d.x[i - 1]), Y(d.gain[i - 1]));
			g.lineTo(px(d.x[i]), Y(d.gain[i]));
			g.stroke();
		}
		g.lineCap = 'butt';
		yLabels(l, Y, lo < 0 ? [lo, 0, hi] : [0, hi / 2, hi], (v) => v.toFixed(2));
	},

	keys(g, l, d, i0, i1, tickPx) {
		const rh = (l.h - 8) / KEY_ROWS.length;
		const rowY = (k) => l.y + 4 + k * rh;
		KEY_ROWS.forEach((name, k) => gutterText.push([name, rowY(k) + rh - 4]));
		const w = Math.max(tickPx, 1);
		for (let i = i0; i <= i1; i++) {
			const b = d.buttons[i];
			const X = px(d.x[i] - 0.5);
			const ideal = d.ideal_key[i];
			const bar = (k, color) => {
				g.fillStyle = color;
				g.fillRect(X, rowY(k) + 2, w, rh - 4);
			};
			if (b & BIT.FORWARD) bar(0, COL.keyW);
			if (b & BIT.MOVELEFT) bar(1, COL.keyA);
			if (b & BIT.MOVERIGHT) bar(2, COL.keyD);
			if (ideal > 0) bar(3, COL.keyA);
			else if (ideal < 0) bar(3, COL.keyD);
			const want = ideal > 0 ? BIT.MOVELEFT : ideal < 0 ? BIT.MOVERIGHT : 0;
			// wrong key or no key while turning; +left/+right ticks aren't mouse turning, so never wrong
		if (want && !(b & want) && !(b & (BIT.LEFT | BIT.RIGHT))) bar(4, COL.bad);
			if (b & (BIT.LEFT | BIT.RIGHT)) bar(5, COL.turn);
		}
		// the ghost's A and D: a thin pink strip along the bottom of those rows (not for replays, whose
		// keys run 3-7 ticks ahead of the angles)
		if (ghost && !isOther(ghost.head)) {
			const gd = ghost.gd;
			g.fillStyle = COL.ghost;
			for (const i of ghost.order) {
				const X = px(gd.x[i] - 0.5);
				if (X < GUTTER - tickPx || X > base.clientWidth) continue;
				if (gd.buttons[i] & BIT.MOVELEFT) g.fillRect(X, rowY(1) + rh - 4, w, 2);
				if (gd.buttons[i] & BIT.MOVERIGHT) g.fillRect(X, rowY(2) + rh - 4, w, 2);
			}
		}
	},

	speed(g, l, d, i0, i1) {
		const hi = Math.max(50, quantile(d, 0, d.n - 1, (i) => d.speed[i], 0.995) * 1.08);
		const Y = yMap(l, 0, hi);
		ghostLine(g, (i) => ghost.gd.speed[i], Y);
		line(g, d, i0, i1, (i) => d.speed[i], Y, COL.line, 2);
		g.fillStyle = COL.opt;
		for (const j of cur.jumps) {
			const X = px(j.x0);
			if (X < GUTTER - 10 || X > base.clientWidth + 10) continue;
			g.beginPath();
			g.moveTo(X, l.y + l.h - 3);
			g.lineTo(X - 5, l.y + l.h - 12);
			g.lineTo(X + 5, l.y + l.h - 12);
			g.closePath();
			g.fill();
		}
		yLabels(l, Y, [0, hi / 2, hi], (v) => v.toFixed(0));
	},

	gaps(g, l, d, i0, i1) {
		g.fillStyle = COL.bad;
		for (let i = Math.max(i0, 1); i <= i1; i++) {
			if (d.gap[i] <= 0) continue;
			const X0 = px(d.x[i - 1] + 0.5);
			const X1 = px(d.x[i] - 0.5);
			g.fillRect(X0, l.y + 4, Math.max(X1 - X0, 2), l.h - 8);
		}
	}
};

function drawHover() {
	drawPathHover();
	const g = over.getContext('2d');
	const r = window.devicePixelRatio || 1;
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.clearRect(0, 0, over.width, over.height);
	g.setTransform(r, 0, 0, r, 0, 0);
	const bottom = LANES[LANES.length - 1].y + LANES[LANES.length - 1].h;
	if (cur && selMistake) {
		const d = cur.d;
		const X0 = Math.max(px(d.x[selMistake.i0] - 0.5), GUTTER);
		const X1 = Math.min(px(d.x[selMistake.i1] + 0.5), GUTTER + plotW());
		if (X1 > X0) {
			g.fillStyle = '#ff5c5c22';
			g.fillRect(X0, 0, X1 - X0, bottom);
			g.strokeStyle = COL.bad;
			g.lineWidth = 2;
			g.strokeRect(X0 + 1, 1, X1 - X0 - 2, bottom - 2);
		}
	}
	if (!cur || hoverIdx < 0) {
		$('readout').innerHTML = '<span class="k">Hover the graph for values.</span>';
		return;
	}
	const d = cur.d;
	const i = hoverIdx;
	const X = Math.round(px(d.x[i])) + 0.5;
	g.strokeStyle = COL.hover;
	g.lineWidth = 1;
	g.beginPath();
	g.moveTo(X, 0);
	g.lineTo(X, bottom);
	g.stroke();
	const b = d.buttons[i];
	const keys = [
		b & BIT.FORWARD ? 'W' : '',
		b & BIT.MOVELEFT ? 'A' : '',
		b & BIT.MOVERIGHT ? 'D' : '',
		b & BIT.JUMP ? 'jump' : '',
		b & BIT.LEFT ? '+left' : '',
		b & BIT.RIGHT ? '+right' : ''
	]
		.filter(Boolean)
		.join(' ');
	const f = (v, n) => (Number.isFinite(v) ? v.toFixed(n) : '–');
	const j = cur.jumps.find((jj) => i >= jj.s && i < jj.e);
	const fields = [
		['tick', `${d.x[i]} (${(d.x[i] / cur.tps).toFixed(2)} s)`],
		['where', d.ground[i] ? 'ground' : j ? (j.num ? `jump ${j.num}` : 'pre-jump') : 'air'],
		['speed', f(d.speed[i], 1)],
		['gain', d.coarse ? 'per jump only' : `${f(d.gain[i], 3)} / ${f(d.ideal[i], 3)}`],
		['gain %', Number.isFinite(cur.path.pct[i]) ? `${cur.path.pct[i].toFixed(1)} (5-tick)` : '–'],
		['yaw', `${f(d.yawd[i], 2)}° (avg ${f(d.yaws[i], 2)}, opt ${f(d.opt[i], 2)})`],
		...mouseField(i),
		['ratio', f(d.ratio[i], 3)],
		['keys', keys || 'none'],
		['ideal', d.ideal_key[i] > 0 ? 'A' : d.ideal_key[i] < 0 ? 'D' : '–']
	];
	if (d.gap[i] > 0) fields.push(['missed before', String(d.gap[i])]);
	if (ghost) {
		const gd = ghost.gd;
		const gi = ghostNearest(gd.x, ghost.order, d.x[i], 0.5);
		const gj = gi < 0 ? null : ghost.jumps.find((jj) => gi >= jj.s && gi < jj.e);
		const where = gi < 0 ? '' : gd.ground[gi] ? 'ground' : gj ? (gj.num ? `jump ${gj.num}` : 'pre-jump') : 'air';
		fields.push([
			'ghost',
			gi < 0
				? 'no row here'
				: `${where} · speed ${f(gd.speed[gi], 1)} · gain ${f(gd.gain[gi], 3)} / ${f(gd.ideal[gi], 3)} · yaw avg ${f(gd.yaws[gi], 2)} · ratio ${f(gd.ratio[gi], 3)}`
		]);
	}
	$('readout').innerHTML = fields.map(([k, v]) => `<span><span class="k">${k}</span> ${v}</span>`).join('');
}

// ---------- top-down path ----------

// Same scale as the drill page and the in-game line: red at 60 % and under, green at 95 % and over
function gainColor(p) {
	if (!Number.isFinite(p)) return '#8c8c96';
	const t = Math.max(0, Math.min(1, (p - 60) / 35));
	const mix = (a, b) => Math.round(a + (b - a) * t);
	return `rgb(${mix(0xff, 0x7b)},${mix(0x5c, 0xd8)},${mix(0x5c, 0x8f)})`;
}

// Rows the path fits: the ticks shown in the graph, or all of them with "Whole path"
function pathRange() {
	const d = cur.d;
	if ($('path-whole').checked) return [0, d.n - 1];
	return [Math.max(0, nearest(view.x0)), Math.min(d.n - 1, nearest(view.x1))];
}

function drawPath() {
	const box = $('path-box');
	const W = box.clientWidth;
	const H = box.clientHeight;
	const g = size($('path-base'), W, H);
	size($('path-over'), W, H);
	pathFit = null;
	$('path-dist').textContent = '';
	g.font = '12px system-ui, sans-serif';
	g.fillStyle = COL.muted;
	if (!cur) {
		g.fillText('Pick an attempt on the left.', 12, 22);
		return;
	}
	const d = cur.d;
	const { x, y, brk, pct } = cur.path;
	const [r0, r1] = pathRange();
	let x0 = Infinity;
	let x1 = -Infinity;
	let y0 = Infinity;
	let y1 = -Infinity;
	const grow = (px, py, i) => {
		if (!Number.isFinite(px[i])) return;
		x0 = Math.min(x0, px[i]);
		x1 = Math.max(x1, px[i]);
		y0 = Math.min(y0, py[i]);
		y1 = Math.max(y1, py[i]);
	};
	for (let i = r0; i <= r1; i++) grow(x, y, i);
	const gIn = ghostInRange(r0, r1);
	if (ghost) for (let i = 0; i < ghost.d.n; i++) if (gIn(i)) grow(ghost.path.x, ghost.path.y, i);
	if (!Number.isFinite(x0)) {
		g.fillText('No path for these ticks.', 12, 22);
		return;
	}
	const PAD = 24;
	// world y points up, so it is flipped on the canvas; at least 64 units across, so a standstill doesn't blow up
	// after a zoom button or a drag the view stays put (pathView) until reset, instead of following the graph
	const v = pathView || {
		s: Math.min((W - 2 * PAD) / Math.max(x1 - x0, 64), (H - 2 * PAD) / Math.max(y1 - y0, 64)),
		cx: (x0 + x1) / 2,
		cy: (y0 + y1) / 2,
	};
	const s = v.s;
	const ox = W / 2 - v.cx * s;
	const oy = H / 2 + v.cy * s;
	$('path-reset').disabled = !pathView;
	pathFit = { s, ox, oy, r0, r1 };
	const runDist = pathDistance(cur.path, Math.min(cur.head.preRows || 0, d.n - 1), runEnd(cur.head, d));
	const ghostDist = ghost ? ` · ghost ${Math.round(pathDistance(ghost.path, Math.min(ghost.head.preRows || 0, ghost.d.n - 1), runEnd(ghost.head, ghost.d)))} units` : '';
	$('path-dist').textContent = `Total distance ${Math.round(runDist)} units${ghostDist} · shown ticks ${Math.round(pathDistance(cur.path, r0, r1))} units`;
	const X = (i) => ox + x[i] * s;
	const Y = (i) => oy - y[i] * s;
	if (ghost) drawGhostPath(g, gIn);
	// one stroke per run of rows with the same colour; rows outside the graph's ticks are dimmed
	g.lineCap = 'round';
	g.lineJoin = 'round';
	let run = null;
	const flush = () => {
		if (!run) return;
		g.strokeStyle = run.col;
		g.globalAlpha = run.dim ? 0.22 : 1;
		g.lineWidth = run.dim ? 2 : 3;
		g.stroke();
		run = null;
	};
	for (let i = 1; i < d.n; i++) {
		if (brk[i] || !Number.isFinite(x[i]) || !Number.isFinite(x[i - 1])) {
			flush();
			continue;
		}
		const col = d.ground[i] ? COL.muted : gainColor(pct[i]);
		const dim = i < r0 || i > r1;
		if (!run || run.col !== col || run.dim !== dim) {
			flush();
			run = { col, dim };
			g.beginPath();
			g.moveTo(X(i - 1), Y(i - 1));
		}
		g.lineTo(X(i), Y(i));
	}
	flush();
	g.globalAlpha = 1;
	// takeoff of each numbered jump, with its number when there's room
	const shown = cur.jumps.filter((j) => j.num && j.s >= r0 && j.s <= r1 && Number.isFinite(x[j.s]));
	g.font = '600 11px system-ui, sans-serif';
	for (const j of shown) {
		g.fillStyle = COL.text;
		g.beginPath();
		g.arc(X(j.s), Y(j.s), 3, 0, 2 * Math.PI);
		g.fill();
		if (shown.length <= 40) g.fillText(String(j.num), X(j.s) + 5, Y(j.s) - 5);
	}
	if (ghost) drawGhostMarks(g, gIn);
	// timer start and run end
	const ring = (i, col, text) => {
		if (i < r0 || i > r1 || !Number.isFinite(x[i])) return;
		g.strokeStyle = col;
		g.lineWidth = 2;
		g.beginPath();
		g.arc(X(i), Y(i), 6, 0, 2 * Math.PI);
		g.stroke();
		g.fillStyle = col;
		g.fillText(text, X(i) + 9, Y(i) + 14);
	};
	ring(Math.min(cur.head.preRows || 0, d.n - 1), COL.opt, 'timer start');
	ring(cur.endIdx, COL.bad, cur.head.reason === 'finish' ? 'finish' : 'end');
	// scale bar
	const unit = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((u) => u * s >= 60) || 10000;
	g.strokeStyle = COL.text;
	g.lineWidth = 2;
	g.beginPath();
	g.moveTo(12, H - 12);
	g.lineTo(12 + unit * s, H - 12);
	g.stroke();
	g.fillStyle = COL.muted;
	g.font = '11px system-ui, sans-serif';
	g.fillText(`${unit} units`, 12, H - 18);
}

// Ghost rows that sit in the graph's ticks (by their aligned tick), or all of them with "Whole path".
// Rows the per-jump alignment squeezed out have no tick: they are drawn dimmed.
function ghostInRange(r0, r1) {
	if (!ghost) return () => false;
	if ($('path-whole').checked) return () => true;
	const lo = cur.d.x[r0] - 0.5;
	const hi = cur.d.x[r1] + 0.5;
	return (i) => ghost.gd.x[i] >= lo && ghost.gd.x[i] <= hi;
}

// The ghost's line on the path: solid (dashes hid the gain colour), under the open attempt, coloured by its
// 5-tick gain % in pink from dark (60 %) to bright (95 %) (a red-green ghost over the red-green path
// couldn't be read)
function drawGhostPath(g, gIn) {
	const { x, y, brk, pct } = ghost.path;
	const { s, ox, oy } = pathFit;
	const X = (i) => ox + x[i] * s;
	const Y = (i) => oy - y[i] * s;
	g.lineCap = 'round';
	g.lineJoin = 'round';
	// one stroke per run of rows with the same colour
	let run = null;
	const flush = () => {
		if (!run) return;
		g.strokeStyle = run.col;
		g.globalAlpha = run.dim ? 0.22 : 1;
		g.lineWidth = run.dim ? 1.5 : 2.2;
		g.stroke();
		run = null;
	};
	for (let i = 1; i < ghost.d.n; i++) {
		if (brk[i] || !Number.isFinite(x[i]) || !Number.isFinite(x[i - 1])) {
			flush();
			continue;
		}
		const col = gainShade(ghost.d.ground[i] ? NaN : pct[i], COL.ghost);
		const dim = !gIn(i);
		if (!run || run.col !== col || run.dim !== dim) {
			flush();
			run = { col, dim };
			g.beginPath();
			g.moveTo(X(i - 1), Y(i - 1));
		}
		g.lineTo(X(i), Y(i));
	}
	flush();
	g.globalAlpha = 1;
}

// The ghost's takeoffs with their jump numbers (pink, left of the dot; the open attempt's sit on the right)
// and a ring where its run ends. Drawn over the open attempt's path.
function drawGhostMarks(g, gIn) {
	const { x, y } = ghost.path;
	const { s, ox, oy } = pathFit;
	const X = (i) => ox + x[i] * s;
	const Y = (i) => oy - y[i] * s;
	const e = runEnd(ghost.head, ghost.d);
	const tk = ghost.jumps.filter((j) => j.num && j.s <= e && gIn(j.s) && Number.isFinite(x[j.s]));
	g.font = '600 11px system-ui, sans-serif';
	g.fillStyle = COL.ghost;
	g.textAlign = 'right';
	for (const j of tk) {
		g.beginPath();
		g.arc(X(j.s), Y(j.s), 3, 0, 2 * Math.PI);
		g.fill();
		if (tk.length <= 40) g.fillText(String(j.num), X(j.s) - 5, Y(j.s) - 5);
	}
	g.textAlign = 'left';
	if (gIn(e) && Number.isFinite(x[e])) {
		g.strokeStyle = COL.ghost;
		g.lineWidth = 2;
		g.beginPath();
		g.arc(X(e), Y(e), 6, 0, 2 * Math.PI);
		g.stroke();
		// above the ring: the open attempt's end label sits below its own ring, often right next to it
		g.fillText(ghost.head.reason === 'finish' ? 'ghost finish' : 'ghost end', X(e) + 9, Y(e) - 8);
	}
}

// Hover dot with the view direction, and the picked mistake's rows
function drawPathHover() {
	const cv = $('path-over');
	const g = cv.getContext('2d');
	const r = window.devicePixelRatio || 1;
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.clearRect(0, 0, cv.width, cv.height);
	g.setTransform(r, 0, 0, r, 0, 0);
	if (!cur || !pathFit) return;
	const { x, y, brk } = cur.path;
	const { s, ox, oy } = pathFit;
	const X = (i) => ox + x[i] * s;
	const Y = (i) => oy - y[i] * s;
	if (selMistake) {
		g.strokeStyle = '#ff5c5caa';
		g.lineWidth = 8;
		g.lineCap = 'round';
		g.beginPath();
		for (let i = selMistake.i0; i <= selMistake.i1; i++) {
			if (!Number.isFinite(x[i])) continue;
			if (i === selMistake.i0 || brk[i] || !Number.isFinite(x[i - 1])) g.moveTo(X(i), Y(i));
			else g.lineTo(X(i), Y(i));
		}
		g.stroke();
	}
	const i = hoverIdx;
	if (i < 0 || !Number.isFinite(x[i])) return;
	// the ghost's row that the graph pairs with this one
	const gi = ghost ? ghostNearest(ghost.gd.x, ghost.order, cur.d.x[i], 0.5) : -1;
	if (gi >= 0 && Number.isFinite(ghost.path.x[gi])) {
		const gx = ox + ghost.path.x[gi] * s;
		const gy = oy - ghost.path.y[gi] * s;
		const ga = (ghost.d.yaw[gi] * Math.PI) / 180 + ghost.path.turn;
		g.strokeStyle = COL.ghost;
		g.lineWidth = 2;
		g.beginPath();
		g.moveTo(gx, gy);
		g.lineTo(gx + Math.cos(ga) * 18, gy - Math.sin(ga) * 18);
		g.stroke();
		g.fillStyle = COL.ghost;
		g.beginPath();
		g.arc(gx, gy, 4, 0, 2 * Math.PI);
		g.fill();
	}
	const a = (cur.d.yaw[i] * Math.PI) / 180 + cur.path.turn;
	g.strokeStyle = COL.hover;
	g.lineWidth = 2;
	g.beginPath();
	g.moveTo(X(i), Y(i));
	g.lineTo(X(i) + Math.cos(a) * 22, Y(i) - Math.sin(a) * 22);
	g.stroke();
	g.fillStyle = COL.hover;
	g.beginPath();
	g.arc(X(i), Y(i), 5, 0, 2 * Math.PI);
	g.fill();
}

// Nearest row to a point on the path canvas, within 14 px: among the rows it fits, or any row once zoomed/panned
function pathRowAt(mx, my) {
	if (!cur || !pathFit) return -1;
	const { x, y } = cur.path;
	const { s, ox, oy } = pathFit;
	const [r0, r1] = pathView ? [0, cur.d.n - 1] : [pathFit.r0, pathFit.r1];
	let best = -1;
	let bd = 14 * 14;
	for (let i = r0; i <= r1; i++) {
		if (!Number.isFinite(x[i])) continue;
		const dx = ox + x[i] * s - mx;
		const dy = oy - y[i] * s - my;
		if (dx * dx + dy * dy < bd) {
			bd = dx * dx + dy * dy;
			best = i;
		}
	}
	return best;
}

// The current fit as a pathView, to zoom or pan from
function pathViewNow() {
	const box = $('path-box');
	const { s, ox, oy } = pathFit;
	return { s, cx: (box.clientWidth / 2 - ox) / s, cy: (oy - box.clientHeight / 2) / s };
}

function pathZoom(f) {
	if (!cur || !pathFit) return;
	const v = pathViewNow();
	pathView = { ...v, s: v.s * f };
	draw();
}
$('path-in').onclick = () => pathZoom(1.5);
$('path-out').onclick = () => pathZoom(1 / 1.5);
$('path-reset').onclick = () => {
	pathView = null;
	draw();
};

// Drag pans the path; a drag of more than 4 px is not a click
let pathDrag = null; // { mx, my, v, moved }
$('path-over').addEventListener('mousedown', (e) => {
	if (e.button !== 0 || !cur || !pathFit) return;
	e.preventDefault();
	pathDrag = { mx: e.clientX, my: e.clientY, v: pathViewNow(), moved: false };
});
window.addEventListener('mousemove', (e) => {
	if (!pathDrag) return;
	const dx = e.clientX - pathDrag.mx;
	const dy = e.clientY - pathDrag.my;
	if (!pathDrag.moved && dx * dx + dy * dy <= 16) return;
	pathDrag.moved = true;
	$('path-over').classList.add('drag');
	const { s, cx, cy } = pathDrag.v;
	pathView = { s, cx: cx - dx / s, cy: cy + dy / s };
	draw();
});
window.addEventListener('mouseup', () => {
	if (!pathDrag) return;
	$('path-over').classList.remove('drag');
	// the click event comes right after this mouseup; leave the flag for it to see
	if (pathDrag.moved) setTimeout(() => (pathDrag = null));
	else pathDrag = null;
});

$('path-over').addEventListener('mousemove', (e) => {
	if (pathDrag) return;
	const rect = e.currentTarget.getBoundingClientRect();
	hoverIdx = pathRowAt(e.clientX - rect.left, e.clientY - rect.top);
	drawHover();
});
$('path-over').addEventListener('mouseleave', () => {
	hoverIdx = -1;
	drawHover();
});
// Click: zoom the graph to that jump, or centre it on that tick when it's on the ground
$('path-over').addEventListener('click', (e) => {
	if (pathDrag?.moved) return;
	const rect = e.currentTarget.getBoundingClientRect();
	const i = pathRowAt(e.clientX - rect.left, e.clientY - rect.top);
	if (i < 0) return;
	const j = cur.jumps.find((jj) => i >= jj.s && i < jj.e);
	if (j) zoomTo(j);
	else {
		const span = view.x1 - view.x0;
		view = { x0: cur.d.x[i] - span / 2, x1: cur.d.x[i] + span / 2 };
		draw();
	}
	hoverIdx = i;
	drawHover();
});
$('path-whole').checked = localStorage.getItem(PATH_WHOLE_KEY) === '1';
$('path-whole').onchange = () => {
	localStorage.setItem(PATH_WHOLE_KEY, $('path-whole').checked ? '1' : '0');
	pathView = null;
	draw();
};
new ResizeObserver(() => draw()).observe($('path-box'));

// ---------- input ----------

function laneAt(y) {
	return LANES.find((l) => y >= l.y && y < l.y + l.h);
}

over.addEventListener('mousemove', (e) => {
	if (!cur) return;
	const rect = over.getBoundingClientRect();
	const mx = e.clientX - rect.left;
	if (drag) {
		const dx = ((mx - drag.mx) / plotW()) * (drag.x1 - drag.x0);
		if (Math.abs(mx - drag.mx) > 3) drag.moved = true;
		view = { x0: drag.x0 - dx, x1: drag.x1 - dx };
		draw();
	}
	hoverIdx = mx >= GUTTER ? nearest(xAt(mx)) : -1;
	drawHover();
});

over.addEventListener('mouseleave', () => {
	hoverIdx = -1;
	drawHover();
});

over.addEventListener('mousedown', (e) => {
	if (!cur) return;
	const rect = over.getBoundingClientRect();
	drag = { mx: e.clientX - rect.left, x0: view.x0, x1: view.x1, moved: false };
});

window.addEventListener('mouseup', (e) => {
	if (!drag) return;
	const moved = drag.moved;
	drag = null;
	if (moved || !cur) return;
	const rect = over.getBoundingClientRect();
	const lane = laneAt(e.clientY - rect.top);
	if (lane && lane.id === 'jumps') {
		const x = xAt(e.clientX - rect.left);
		const j = cur.jumps.find((jj) => x >= jj.x0 - 0.5 && x <= jj.x1 + 0.5);
		if (j) zoomTo(j);
	}
});

over.addEventListener(
	'wheel',
	(e) => {
		if (!cur) return;
		const rect = over.getBoundingClientRect();
		// over the lane titles the wheel scrolls the page
		if (e.clientX - rect.left < GUTTER) return;
		e.preventDefault();
		const at = xAt(e.clientX - rect.left);
		const k = Math.exp(e.deltaY * 0.0015);
		const full = fullRange();
		let span = Math.min(Math.max((view.x1 - view.x0) * k, 20), full.x1 - full.x0);
		const t = (at - view.x0) / (view.x1 - view.x0);
		view = { x0: at - t * span, x1: at - t * span + span };
		draw();
	},
	{ passive: false }
);

over.addEventListener('dblclick', whole);
$('whole').onclick = whole;
$('jump1').onclick = () => {
	if (cur && cur.j1 >= 0) zoomTo(cur.jumps[cur.j1]);
};
$('refresh').onclick = loadList;
$('align').value = localStorage.getItem(ALIGN_KEY) === 'timer' ? 'timer' : 'jump';
$('cmp-sel').onchange = compareChanged;
$('to-compare').onclick = () => {
	if (!cur) return;
	const ids = [cur.head.id, ...(ghost ? [ghost.head.id] : [])];
	location.href = `/compare#${cur.head.dir}/${ids.join(',')}`;
};
$('align').onchange = compareChanged;
$('yaw-signed').checked = localStorage.getItem(YAW_SIGNED_KEY) === '1';
LANES.find((l) => l.id === 'yaw').sub = YAW_SUB[$('yaw-signed').checked ? 'signed' : 'size'];
$('yaw-signed').onchange = () => {
	localStorage.setItem(YAW_SIGNED_KEY, $('yaw-signed').checked ? '1' : '0');
	LANES.find((l) => l.id === 'yaw').sub = YAW_SUB[$('yaw-signed').checked ? 'signed' : 'size'];
	draw();
};
$('show-drills').checked = localStorage.getItem(DRILLS_KEY) === '1';
$('show-drills').onchange = () => {
	localStorage.setItem(DRILLS_KEY, $('show-drills').checked ? '1' : '0');
	renderList();
};
for (const [, id] of FILTERS) $(id).onchange = filtersChanged;
$('f-clear').onclick = () => {
	for (const [, id] of FILTERS) $(id).value = '';
	filtersChanged();
};
$('tag-add').onkeydown = (e) => {
	if (e.key === 'Enter') addTag();
};
$('note').onkeydown = (e) => {
	if (e.key === 'Enter') $('note').blur();
	if (e.key === 'Escape') {
		$('note').value = listEntry()?.note || '';
		$('note').blur();
	}
};
$('note').onchange = () => {
	const v = $('note').value.trim();
	if (v !== (listEntry()?.note || '')) saveMeta({ note: v });
};
// Check settings open as a panel under the toolbar, over the graph
$('checks-btn').onclick = () => {
	const sec = $('settings');
	sec.hidden = !sec.hidden;
	if (!sec.hidden) showSettings();
};
$('close-checks').onclick = () => ($('settings').hidden = true);
window.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') $('settings').hidden = true;
});
$('reset-checks').onclick = () => {
	localStorage.removeItem(SETTINGS_KEY);
	showSettings();
	findMistakes();
	draw();
};
new ResizeObserver(() => draw()).observe($('plot'));

// Turn speed in mouse terms for the readout: the 5-tick average and the optimal, in cm/s. A replay's
// turn is shown at your sens, as the mouse speed you'd need to copy it.
function mouseField(i) {
	const m = mouseFor(cur.head, mouseNow, dpi);
	const d = cur.d;
	if (!m || !Number.isFinite(d.yaws[i]) || turnBtn(d, i)) return [];
	const opt = Number.isFinite(d.opt[i]) ? `, opt ${cmPerSec(d.opt[i], cur.head.interval, m).toFixed(1)}` : '';
	const whose = isOther(cur.head) ? ' at your sens' : m.recorded ? '' : ' at current sens';
	return [['mouse', `${cmPerSec(Math.abs(d.yaws[i]), cur.head.interval, m).toFixed(1)} cm/s${opt}${whose}`]];
}

function showCm360() {
	const m = mouseFor(cur ? cur.head : list.find((a) => !isOther(a)), mouseNow, dpi);
	$('cm360').textContent = m ? `${(360 * m.cmPerDeg).toFixed(1)} cm/360° at sens ${m.sens}` : '';
}

$('auto-old').value = loadAutoOpts().oldMin;
$('auto-old').onchange = () => {
	const v = Number.parseInt($('auto-old').value, 10);
	saveAutoOpts({ oldMin: Number.isInteger(v) && v >= 0 ? v : AUTO_OLD_MIN });
	$('auto-old').value = loadAutoOpts().oldMin;
	autoTags(list);
	fillFilters();
	renderList();
	showMeta();
};
$('dpi').onchange = () => {
	dpi = Number.parseFloat($('dpi').value);
	saveDpi(dpi);
	if (!(dpi > 0)) dpi = null;
	showCm360();
	showRunStats();
};

// A new attempt saved by the collector shows up in the list at once (the open one stays open)
new EventSource('/api/events').addEventListener('attempt', loadList);

Promise.all([
	loadList(),
	fetch('/api/mouse')
		.then((r) => r.json())
		.then((v) => (mouseNow = v))
		.catch(() => {})
]).then(async () => {
	dpi = loadDpi() ?? dpiFromHeads(list);
	if (dpi) $('dpi').value = dpi;
	showCm360();
	// #<map>/<id>/j1 (from the drill page) opens the attempt zoomed to jump 1
	const [dir, id, what] = location.hash.slice(1).split('/');
	if (dir && id) {
		await open(dir, id);
		if (what === 'j1' && cur && cur.j1 >= 0) zoomTo(cur.jumps[cur.j1]);
	} else {
		const first = list.find(shown) || list.find((a) => !isFragment(a)) || list[0];
		if (first) open(first.dir, first.id);
	}
});
