'use strict';
// Strafe Review compare page: 2-4 recordings on one map and tickrate, side by side. The first pick is
// the reference; the others are lined up with it by alignGhost() (data.js), per jump or on the timer
// start. Stats come from summarize() (stats.js), mistakes from runChecks() (checks.js).
// URL: /compare#<map>/<id>,<id>,... (first id = reference).

const COLORS = ['#4fc3f7', '#ff79c6', '#ffb454', '#c792ea']; // no green or red: those mean optimal and loss here
const MAX_PICKS = 4;
const SETTINGS_KEY = 'strafe-review-checks'; // the main page's check settings
const ALIGN_KEY = 'strafe-review-align';
const DRILLS_KEY = 'strafe-review-compare-drills';
const SORT_KEY = 'strafe-review-compare-sort';
const DRILL_MAX_JUMPS = 7;
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
const C = {
	card: '#232733',
	border: '#4a5468',
	grid: '#3a4152',
	text: '#e6e9ef',
	muted: '#a3abba',
	opt: '#7bd88f',
	band: '#7bd88f2e',
	ground: '#c8d2e61f',
	pre: '#6c9cff14',
	hover: '#ffffffcc'
};
const GUTTER = 128;
const RIGHT_PAD = 12;
const LANE_GAP = 8;
const AXIS_H = 30;

const $ = (id) => document.getElementById(id);
const base = $('base');
const over = $('over');
let list = [];
let picks = []; // ids in pick order; picks[0] is the reference
const recs = new Map(); // id -> { head, d, jumps, stats, mistakes }
let shown = []; // [{ id, head, d, jumps, stats, mistakes, color, gd, order }] in pick order, aligned
let view = { x0: 0, x1: 1 };
let hoverX = null;
let drag = null;
let lanes = [];
let mouseNow = null; // the game's sensitivity and m_yaw now (/api/mouse), for recordings that didn't record theirs
let dpi = null; // the mouse DPI typed in on the main page (mouse.js), or what Momentum stored

const key = (h) => `${h.dir}/${h.id}`;
const mapKey = (h) => `${course(h)}|${h.interval}`;
const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '–');

function when(ms) {
	return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isDrill(h) {
	return !isOther(h) && h.reason !== 'finish' && Number.isFinite(h.landed) && h.landed <= DRILL_MAX_JUMPS;
}

// Same rule as the main page: a replay recording with no landed jump, or a shorter copy of a replay
// file that was recorded again
function isFragment(h) {
	if (!isOther(h)) return false;
	if (h.landed === 0) return true;
	const fl = h.replayFile;
	return !!fl && list.some((o) => o !== h && isOther(o) && o.replayFile === fl && o.rowCount > h.rowCount);
}

function labelText(h) {
	if (isOther(h)) return whoseRun(h);
	return isDrill(h) ? `Drill · ${h.landed} jump${h.landed === 1 ? '' : 's'}` : 'Own run';
}

function labelChip(h) {
	const el = document.createElement('span');
	el.className = `chip ${isOther(h) ? 'replay' : isDrill(h) ? 'drill' : 'own'}`;
	el.textContent = labelText(h);
	return el;
}

// How the recording ended, in words. A replay that ended 'replaced' was stopped, not finished (the server
// turns a replay played to the end into 'finish', see replay_finished()).
function endText(h) {
	if (h.reason === 'finish' && h.runTime) return `Finished ${h.runTime.toFixed(2)} s`;
	const r = REASONS[h.reason] || h.reason || '?';
	return h.runTime ? `${r} at ${h.runTime.toFixed(2)} s` : r;
}

function loadSettings() {
	try {
		return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
	} catch {
		return {};
	}
}

// Same baseline as the main page: median jump-1 takeoff of the other own attempts on this map and tickrate
function takeoffBaseline(h) {
	const vs = list
		.filter((a) => course(a) === course(h) && a.interval === h.interval && !isOther(a) && a.id !== h.id && a.j1Takeoff >= MIN_TAKEOFF)
		.map((a) => a.j1Takeoff);
	return vs.length ? { takeoffMedian: median(vs), takeoffRuns: vs.length } : null;
}

// ---------- list and picks ----------

async function loadList() {
	list = await (await fetch('/api/attempts')).json();
	autoTags(list);
	const sel = $('map');
	const cur = sel.value;
	const maps = new Map();
	for (const h of list) if (!maps.has(mapKey(h))) maps.set(mapKey(h), h); // list is newest first
	sel.replaceChildren(...[...maps.values()].map((h) => new Option(`${course(h)} · ${tickRate(h.interval)} tick`, mapKey(h))));
	if (cur && maps.has(cur)) sel.value = cur;
	showPicker();
}

function mapList() {
	const mk = $('map').value;
	const showDrills = $('show-drills').checked;
	const q = $('search').value;
	const hs = list.filter((h) => mapKey(h) === mk && !isFragment(h) && (picks.includes(h.id) || ((showDrills || !isDrill(h)) && matchesSearch(h, q))));
	return sortHeads(hs, $('sort').value);
}

// Quick picks that follow the saved recordings on this map: each resolves to one recording, or null
function presets() {
	const mk = $('map').value;
	const cands = list.filter((h) => mapKey(h) === mk && !isFragment(h));
	const own = cands.filter((h) => !isOther(h));
	const reps = cands.filter((h) => isOther(h));
	const minBy = (hs, f) => hs.reduce((b, h) => (Number.isFinite(f(h)) && (!b || f(h) < f(b)) ? h : b), null);
	const fin = (h) => (h.reason === 'finish' && h.runTime ? h.runTime : NaN);
	// A replay recording can stop before the run's end (its runTime is then short), so only replays that
	// got within 75 % of the longest replay time count, and the shortest of those wins
	const longest = Math.max(0, ...reps.map((h) => h.runTime || 0));
	const topRep = minBy(reps, (h) => (h.runTime >= 0.75 * longest ? h.runTime : NaN));
	return [
		{ name: 'Your fastest finish', h: minBy(own, fin), fact: (h) => `${h.runTime.toFixed(2)} s` },
		{ name: 'Your best jump 1', h: minBy(own, (h) => (h.j1Land == null ? NaN : -h.j1Land)), fact: (h) => `lands ${h.j1Land.toFixed(0)} u/s` },
		{ name: 'Top replay', h: topRep, fact: (h) => `${h.player || 'unknown player'}${h.runTime ? ` · ${h.runTime.toFixed(2)} s` : ''}` }
	];
}

// Quick pick buttons: click adds the recording (or takes it out again when it is picked)
function showPresets() {
	const box = $('presets');
	box.replaceChildren();
	for (const p of presets()) {
		const b = document.createElement('button');
		const at = p.h ? picks.indexOf(p.h.id) : -1;
		b.textContent = p.h ? `${p.name}: ${p.fact(p.h)}` : `${p.name}: none saved`;
		b.disabled = !p.h || (at < 0 && picks.length >= MAX_PICKS);
		if (at >= 0) {
			b.classList.add('on');
			b.style.borderColor = COLORS[at];
		}
		b.onclick = () => {
			picks = at >= 0 ? picks.filter((x) => x !== p.h.id) : [...picks, p.h.id];
			changed();
		};
		box.append(b);
	}
}

function showPicker() {
	showPresets();
	const box = $('pick-list');
	box.replaceChildren();
	const hs = mapList();
	if (!hs.length) box.textContent = $('search').value.trim() ? 'No recording on this map matches the search.' : 'No recordings on this map.';
	for (const h of hs) {
		const at = picks.indexOf(h.id);
		const row = document.createElement('div');
		row.className = `pick${at >= 0 ? ' on' : ''}${at < 0 && picks.length >= MAX_PICKS ? ' off' : ''}`;
		if (at >= 0) {
			row.style.borderColor = COLORS[at];
			row.style.boxShadow = `inset 0 0 0 1px ${COLORS[at]}`; // 2 px look without a size change
		}
		const sw = document.createElement('span');
		sw.className = 'sw';
		sw.style.background = at >= 0 ? COLORS[at] : 'transparent';
		// fixed columns, so picking a row never changes its size: swatch, label, started, end, jump 1, action
		const col = (text, cls = 'meta') => {
			const s = document.createElement('span');
			s.className = cls;
			s.textContent = text;
			return s;
		};
		const lab = document.createElement('span');
		lab.append(labelChip(h));
		row.append(sw, lab, col(when(h.started)), col(endText(h)), col(h.j1Land == null ? '' : `jump 1 lands ${h.j1Land.toFixed(0)}`));
		if (at < 0) row.append(col(''));
		if (at === 0) {
			const r = document.createElement('span');
			r.className = 'ref';
			r.textContent = 'reference';
			row.append(r);
		} else if (at > 0) {
			const b = document.createElement('button');
			b.textContent = 'Make reference';
			b.title = 'Line the others up with this one';
			b.onclick = (e) => {
				e.stopPropagation();
				picks = [h.id, ...picks.filter((x) => x !== h.id)];
				changed();
			};
			row.append(b);
		}
		row.onclick = () => {
			if (at >= 0) picks = picks.filter((x) => x !== h.id);
			else if (picks.length < MAX_PICKS) picks.push(h.id);
			else return;
			changed();
		};
		box.append(row);
	}
	$('pick-sum').textContent = `${picks.length} of ${MAX_PICKS} picked`;
}

async function changed() {
	const h = list.find((x) => x.id === picks[0]);
	location.hash = picks.length ? `${h ? h.dir : ''}/${picks.join(',')}` : '';
	showPicker();
	await build();
}

async function rec(h) {
	if (recs.has(h.id)) return recs.get(h.id);
	const res = await fetch(`/api/attempt/${encodeURIComponent(h.dir)}/${encodeURIComponent(h.id)}`);
	if (!res.ok) return null;
	const a = await res.json();
	a.dir = h.dir;
	const d = parse(a);
	const { jumps } = findJumps(d, a.preRows);
	const stats = summarize(a, d, jumps);
	const replay = isOther(a);
	// Weak takeoff compares with the owner's own median, which says nothing about someone else's replay
	const mistakes = runChecks(d, jumps, stats.endIdx, loadSettings(), replay ? null : takeoffBaseline(a), replay);
	// the path from the recording's own rows (the aligned copy's gaps would bend it), nothing after the run end
	const path = recordingPath(a, d, jumps, stats.endIdx);
	for (let i = stats.endIdx + 1; i < d.n; i++) path.x[i] = path.y[i] = NaN;
	const r = { head: a, d, jumps, stats, mistakes, path };
	recs.set(h.id, r);
	return r;
}

async function build() {
	const hs = picks.map((id) => list.find((x) => x.id === id)).filter(Boolean);
	const got = [];
	for (const h of hs) {
		try {
			const r = await rec(h);
			if (r) got.push({ id: h.id, ...r });
		} catch (e) {
			console.error('recording not loaded', h.id, e);
		}
	}
	const mode = $('align').value;
	shown = got.map((r, k) => {
		let x = r.d.x;
		let gap = r.d.gap;
		let used = 'reference';
		let matched = 0;
		if (k > 0) {
			const al = alignGhost(got[0], r, mode);
			x = al.x;
			gap = al.gap;
			used = al.mode;
			matched = al.matched;
		}
		const gd = Object.assign({}, r.d, { x, gap });
		// rows after the run end are left out (a replay keeps sending rows while paused at its end)
		const order = [];
		for (let i = 0; i <= r.stats.endIdx; i++) if (Number.isFinite(gd.x[i])) order.push(i);
		// every path in the reference's turn, so they share one frame
		const path = turnPath(r.path, got[0].path.turn);
		return { ...r, color: COLORS[k], gd, order, used, matched, path };
	});
	pathView = null;
	const ids = shown.map((r) => r.id);
	if (!ids.includes(pathFocus)) pathFocus = ids[0] ?? null;
	if (!ids.includes(pathCmp) || pathCmp === pathFocus) pathCmp = ids.find((id) => id !== pathFocus) ?? null;
	showPathRoles();
	showStats();
	showPerJump();
	showMistakes();
	showLegend();
	whole();
}

// ---------- tables ----------

function colHead(r) {
	const el = document.createElement('div');
	el.className = 'colhead';
	const top = document.createElement('span');
	const sw = document.createElement('span');
	sw.className = 'sw';
	sw.style.background = r.color;
	top.append(sw, labelChip(r.head));
	const sub = document.createElement('span');
	sub.className = 'sub';
	sub.textContent = when(r.head.started);
	el.append(top, sub);
	return el;
}

// rows: [{ name, row, vals: [text or Node], nums: [number], best: 'max' | 'min' | target number, na: [bool], naWhy: [text] }]
// or { group }. row (runrows.js) gives the hover tip
function table(rows) {
	const t = document.createElement('table');
	t.className = 'cmp';
	const thead = t.createTHead().insertRow();
	thead.append(document.createElement('th'));
	for (const r of shown) {
		const th = document.createElement('th');
		th.append(colHead(r));
		thead.append(th);
	}
	const body = t.createTBody();
	for (const row of rows) {
		const tr = body.insertRow();
		const th = document.createElement('th');
		if (row.group) {
			tr.className = 'grp';
			th.textContent = row.group;
			th.colSpan = shown.length + 1;
			tr.append(th);
			continue;
		}
		th.textContent = row.name;
		if (row.row && (row.row.desc || row.row.tip)) {
			th.classList.add('tipped');
			th.onmouseenter = () => showRsTip(th, row.row);
			th.onmouseleave = hideRsTip;
		}
		tr.append(th);
		let bi = -1;
		if (row.best && row.nums) {
			const score = (v) => (row.best === 'max' ? v : row.best === 'min' ? -v : -Math.abs(v - row.best));
			const ok = row.nums.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v));
			if (ok.length > 1 && new Set(ok.map(([v]) => v)).size > 1) bi = ok.reduce((b, c) => (score(c[0]) > score(b[0]) ? c : b))[1];
		}
		row.vals.forEach((v, i) => {
			const td = tr.insertCell();
			if (i === bi) {
				td.classList.add('best');
				const star = document.createElement('span');
				star.className = 'star';
				star.textContent = '★ ';
				td.append(star);
			}
			if (v instanceof Node) td.append(v);
			else td.append(v);
			if (row.na && row.na[i]) {
				td.classList.add('na');
				if (row.naWhy) td.title = row.naWhy[i];
			}
		});
	}
	return t;
}

function cell(main, sub) {
	const s = document.createElement('span');
	s.textContent = main;
	if (sub) {
		const e = document.createElement('span');
		e.className = 'sub';
		e.textContent = sub;
		s.append(e);
	}
	return s;
}

// The run stat rows of the main page (runrows.js), one column per recording. Each row's best value
// gets a star; rows without a better direction are not ranked
function showStats() {
	const box = $('stats-body');
	box.replaceChildren();
	hideRsTip(); // its row is about to be replaced
	if (shown.length < 2) {
		box.className = 'muted';
		box.textContent = shown.length ? 'Pick at least one more recording.' : 'Pick at least 2 recordings.';
		return;
	}
	box.className = '';
	const ctx = {
		cms: (r, deg) => {
			const m = mouseFor(r.head, mouseNow, dpi);
			return m && Number.isFinite(deg) ? ` · ${cmPerSec(deg, r.head.interval, m).toFixed(1)} cm/s` : '';
		},
		sw: switchThresholds(loadSettings()),
		zoomJump: (num) => zoomToJump(num),
		zoomSwap: (w, r) => {
			const x = r.gd.x[w.i];
			if (Number.isFinite(x)) zoomTo(x - 25, x + 25);
		}
	};
	const rows = [];
	for (const card of runStatRows(ctx)) {
		rows.push({ group: card.title });
		for (const row of card.rows) {
			const off = shown.map((r) => skipRow(r, row.need));
			rows.push({
				name: row.name,
				row,
				vals: shown.map((r, i) => {
					if (off[i]) return '–';
					const c = cell(row.v(r.stats, r), row.sub ? row.sub(r.stats, r) : '');
					if (row.click) {
						c.classList.add('link');
						c.onclick = () => {
							row.click(r.stats, r);
							$('plot').scrollIntoView({ block: 'nearest' });
						};
					}
					return c;
				}),
				nums: row.best !== undefined && row.num ? shown.map((r, i) => (off[i] ? NaN : row.num(r.stats, r))) : null,
				best: row.best,
				na: off,
				naWhy: shown.map((r) => skipWhy(r))
			});
		}
	}
	box.append(table(rows));
}

function showPerJump() {
	const box = $('pj-body');
	box.replaceChildren();
	$('pj-note').textContent = '';
	if (shown.length < 2) return;
	const max = Math.max(...shown.map((r) => r.stats.jumps));
	const counts = new Set(shown.map((r) => r.stats.landed));
	$('pj-note').textContent =
		'gain % · CS:S (SSJ) gain · sync · strafes, matched by jump number' +
		(counts.size > 1 ? ' · jump counts differ, so after a skipped jump a row compares different blocks' : '');
	const rows = [];
	for (let n = 1; n <= max; n++) {
		const js = shown.map((r) => r.stats.perJump.find((j) => j.num === n));
		rows.push({
			name: `Jump ${n}`,
			vals: js.map((j) => (j ? cell(`${f(j.pct)} %`, `CS:S ${f(j.ssj, 1)} % · sync ${f(j.sync, 0)} % · ${j.strafes} strafes${j.landed ? '' : ' · run ended'}`) : '–')),
			nums: js.map((j) => (j ? j.pct : NaN)),
			best: 'max'
		});
	}
	box.append(table(rows));
}

function showMistakes() {
	const box = $('mist-body');
	box.replaceChildren();
	if (shown.length < 2) return;
	const names = [...new Set(CHECKS.map((c) => c.name))];
	const rows = [];
	for (const name of names) {
		const cId = CHECKS.find((c) => c.name === name).id;
		const per = shown.map((r) => r.mistakes.filter((m) => m.name === name));
		const skipped = shown.map((r) => isOther(r.head) && ((!r.d.ownKeys && REPLAY_SKIP.includes(cId)) || cId === 'takeoff'));
		if (per.every((p) => !p.length) && !skipped.some(Boolean)) continue;
		rows.push({
			name,
			vals: per.map((p, i) => (skipped[i] ? 'not run (replay)' : p.length ? `${p.length} · ${f(p.reduce((a, m) => a + m.lost, 0), 1)} u/s` : '0')),
			na: skipped,
			nums: per.map((p, i) => (skipped[i] ? NaN : p.reduce((a, m) => a + m.lost, 0))),
			best: 'min'
		});
	}
	if (!rows.length) box.textContent = 'No mistakes found in any of them.';
	else box.append(table(rows));
}

function showLegend() {
	const box = $('legend');
	box.replaceChildren();
	for (const [k, r] of shown.entries()) {
		const s = document.createElement('span');
		const sw = document.createElement('span');
		sw.className = 'sw';
		sw.style.background = r.color;
		const t = document.createElement('span');
		const al = k === 0 ? 'reference' : r.used === 'jump' ? `per jump (${r.matched} matched)` : $('align').value === 'jump' ? 'timer start (no jump in common)' : 'timer start';
		t.textContent = `${labelText(r.head)} · ${when(r.head.started)} · ${al}${r.d.derived ? ' · gain and angle rebuilt from speed' : ''}`;
		s.append(sw, t);
		box.append(s);
	}
}

// ---------- graph ----------

function layout() {
	const n = Math.max(shown.length, 1);
	lanes = [
		{ id: 'jumps', title: 'Jumps', sub: 'gain % per jump', h: 14 + n * 18 },
		{ id: 'speed', title: 'Speed', sub: 'u/s', h: 130 },
		{ id: 'yaw', title: 'Yaw speed', sub: '°/tick, 5-tick avg', h: 130 },
		{ id: 'ratio', title: 'Angle', sub: 'yawRatio, 1 = optimal', h: 110 },
		{ id: 'gain', title: 'Gain', sub: 'u/s per tick', h: 120 }
	];
	let y = 0;
	for (const l of lanes) {
		l.y = y;
		y += l.h + LANE_GAP;
	}
	return y + AXIS_H;
}

function plotW() {
	return base.clientWidth - GUTTER - RIGHT_PAD;
}
function px(x) {
	return GUTTER + ((x - view.x0) / (view.x1 - view.x0)) * plotW();
}
function xAt(p) {
	return view.x0 + ((p - GUTTER) / plotW()) * (view.x1 - view.x0);
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

function fullRange() {
	let lo = Infinity;
	let hi = -Infinity;
	for (const r of shown) {
		if (!r.order.length) continue;
		lo = Math.min(lo, r.gd.x[r.order[0]]);
		hi = Math.max(hi, r.gd.x[r.order[r.order.length - 1]]);
	}
	return Number.isFinite(lo) ? { x0: lo - 5, x1: hi + 5 } : { x0: 0, x1: 100 };
}

function whole() {
	view = fullRange();
	draw();
}

function zoomTo(x0, x1) {
	const pad = Math.max(10, (x1 - x0) * 0.08);
	view = { x0: x0 - pad, x1: x1 + pad };
	draw();
}

function niceStep(span, pxWidth, minPx) {
	const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000];
	for (const s of steps) if ((s / span) * pxWidth >= minPx) return s;
	return steps[steps.length - 1];
}

function yMap(l, lo, hi) {
	const top = l.y + 6;
	const bot = l.y + l.h - 6;
	return (v) => bot - ((v - lo) / (hi - lo || 1)) * (bot - top);
}

// Rows of r that are in view (x only ever goes up over r.order)
function inView(r) {
	const out = [];
	for (const i of r.order) {
		const x = r.gd.x[i];
		if (x >= view.x0 - 2 && x <= view.x1 + 2) out.push(i);
	}
	return out;
}

// q-th fraction of a value over every row of every shown recording (scales cover all of them, and
// stay put while panning or zooming)
function quantAll(val, ok, q) {
	const vs = [];
	for (const r of shown) for (const i of r.order) if (ok(r.gd, i)) {
		const v = val(r.gd, i);
		if (Number.isFinite(v)) vs.push(v);
	}
	if (!vs.length) return NaN;
	vs.sort((a, b) => a - b);
	return vs[Math.min(vs.length - 1, Math.floor(q * vs.length))];
}

const strafeRow = (d, i) => !d.ground[i] && d.speed[i] > 100;
const airRow = (d, i) => !d.ground[i];

function line(g, d, idx, val, Y, color, width, ok = () => true, dash = []) {
	g.strokeStyle = color;
	g.lineWidth = width;
	g.setLineDash(dash);
	g.beginPath();
	let pen = false;
	for (const i of idx) {
		const v = val(d, i);
		if (!Number.isFinite(v) || !ok(d, i)) {
			pen = false;
			continue;
		}
		if (d.gap[i] > 0) pen = false;
		const X = px(d.x[i]);
		const yv = Y(v);
		if (pen) g.lineTo(X, yv);
		else g.moveTo(X, yv);
		pen = true;
	}
	g.stroke();
	g.setLineDash([]);
}

let gutterText = [];
function yLabels(l, Y, values, fmt) {
	for (const v of values) gutterText.push([fmt(v), Math.min(Math.max(Y(v) + 4, l.y + 44), l.y + l.h - 2)]);
}

const LANE = {
	jumps(g, l) {
		g.font = '600 11px system-ui, sans-serif';
		shown.forEach((r, k) => {
			const y = l.y + 7 + k * 18;
			for (const j of r.jumps) {
				if (!j.num) continue;
				let a = NaN;
				let b = NaN;
				for (let i = j.s; i < Math.min(j.e, r.stats.endIdx + 1); i++) {
					const x = r.gd.x[i];
					if (!Number.isFinite(x)) continue;
					if (!Number.isFinite(a)) a = x;
					b = x;
				}
				if (!Number.isFinite(a)) continue;
				const X0 = px(a - 0.5);
				const X1 = px(b + 0.5);
				if (X1 < GUTTER || X0 > base.clientWidth) continue;
				g.fillStyle = `${r.color}40`;
				g.fillRect(X0 + 1, y, X1 - X0 - 2, 15);
				g.strokeStyle = r.color;
				g.strokeRect(X0 + 1.5, y + 0.5, X1 - X0 - 3, 14);
				const t = `${j.num} · ${f(j.pct)}%`;
				if (g.measureText(t).width < X1 - X0 - 8) {
					g.fillStyle = C.text;
					g.fillText(t, X0 + 5, y + 11);
				}
			}
		});
	},

	speed(g, l) {
		const hi = Math.max(50, quantAll((d, i) => d.speed[i], () => true, 0.995) * 1.08);
		const Y = yMap(l, 0, hi);
		for (const r of [...shown].reverse()) line(g, r.gd, inView(r), (d, i) => d.speed[i], Y, r.color, 2);
		yLabels(l, Y, [0, hi / 2, hi], (v) => v.toFixed(0));
	},

	yaw(g, l) {
		const optMax = quantAll((d, i) => d.opt[i], strafeRow, 0.98);
		const hi = Number.isFinite(optMax) ? optMax * 2.2 : 5;
		const Y = yMap(l, 0, hi);
		const ref = shown[0];
		if (ref) {
			const idx = inView(ref);
			g.fillStyle = C.band;
			for (const i of idx) {
				const o = ref.gd.opt[i];
				if (!Number.isFinite(o)) continue;
				g.fillRect(px(ref.gd.x[i] - 0.5), Y(o * 1.15), Math.max(px(ref.gd.x[i] + 0.5) - px(ref.gd.x[i] - 0.5), 1), Y(o * 0.85) - Y(o * 1.15));
			}
			line(g, ref.gd, idx, (d, i) => d.opt[i], Y, C.opt, 1.2, () => true, [4, 3]);
		}
		for (const r of [...shown].reverse()) line(g, r.gd, inView(r), (d, i) => Math.abs(d.yaws[i]), Y, r.color, 1.8, airRow);
		yLabels(l, Y, [0, hi / 2, hi], (v) => v.toFixed(1));
	},

	ratio(g, l) {
		const Y = yMap(l, 0, 2);
		g.fillStyle = C.band;
		g.fillRect(GUTTER, Y(1.15), plotW(), Y(0.85) - Y(1.15));
		g.strokeStyle = C.opt;
		g.lineWidth = 1.2;
		g.beginPath();
		g.moveTo(GUTTER, Y(1));
		g.lineTo(base.clientWidth, Y(1));
		g.stroke();
		for (const r of [...shown].reverse()) line(g, r.gd, inView(r), (d, i) => Math.min(d.ratio[i], 2), Y, r.color, 1.6, airRow);
		yLabels(l, Y, [0, 1, 2], (v) => (v === 2 ? '≥2' : String(v)));
		g.fillStyle = C.muted;
		g.font = '11px system-ui, sans-serif';
		g.fillText('too wide', GUTTER + 6, l.y + 14);
		g.fillText('too narrow', GUTTER + 6, l.y + l.h - 6);
	},

	gain(g, l) {
		const hi = Math.max(0.1, quantAll((d, i) => Math.max(d.ideal[i], d.gain[i]), strafeRow, 0.98) * 1.1);
		const Y = yMap(l, 0, hi);
		const ref = shown[0];
		if (ref) line(g, ref.gd, inView(ref), (d, i) => d.ideal[i], Y, C.opt, 1.2, airRow, [4, 3]);
		for (const r of [...shown].reverse()) line(g, r.gd, inView(r), (d, i) => Math.max(d.gain[i], 0), Y, r.color, 1.6, airRow);
		yLabels(l, Y, [0, hi / 2, hi], (v) => v.toFixed(2));
	}
};

function draw() {
	const W = $('plot').clientWidth;
	const H = layout();
	$('plot').style.height = `${H}px`;
	const g = size(base, W, H);
	size(over, W, H);
	drawPath();
	if (!shown.length) return;
	const ref = shown[0];
	const step = niceStep(view.x1 - view.x0, plotW(), 80);
	const gridStart = Math.ceil(view.x0 / step) * step;
	const tickPx = plotW() / (view.x1 - view.x0);
	for (const l of lanes) {
		g.fillStyle = C.card;
		g.fillRect(GUTTER, l.y, plotW(), l.h);
		g.fillStyle = C.text;
		g.font = '600 13px system-ui, sans-serif';
		g.fillText(l.title, 8, l.y + 16);
		g.font = '11px system-ui, sans-serif';
		g.fillStyle = C.muted;
		if (l.h > 30) g.fillText(l.sub, 8, l.y + 31);
		g.save();
		g.beginPath();
		g.rect(GUTTER, l.y, plotW(), l.h);
		g.clip();
		g.fillStyle = C.pre;
		g.fillRect(GUTTER, l.y, px(-0.5) - GUTTER, l.h);
		if (l.id !== 'jumps') {
			// the reference's ground ticks
			g.fillStyle = C.ground;
			for (const i of inView(ref)) if (ref.gd.ground[i]) g.fillRect(px(ref.gd.x[i] - 0.5), l.y, Math.max(tickPx, 1), l.h);
		}
		g.strokeStyle = C.grid;
		g.lineWidth = 1;
		g.beginPath();
		for (let x = gridStart; x <= view.x1; x += step) {
			const X = Math.round(px(x)) + 0.5;
			g.moveTo(X, l.y);
			g.lineTo(X, l.y + l.h);
		}
		g.stroke();
		gutterText = [];
		LANE[l.id](g, l);
		g.restore();
		g.fillStyle = C.muted;
		g.font = '11px system-ui, sans-serif';
		g.textAlign = 'right';
		for (const [t, y] of gutterText) g.fillText(t, GUTTER - 6, y);
		g.textAlign = 'left';
		g.strokeStyle = C.border;
		g.strokeRect(GUTTER + 0.5, l.y + 0.5, plotW() - 1, l.h - 1);
	}
	const last = lanes[lanes.length - 1];
	const ay = last.y + last.h + 4;
	g.fillStyle = C.muted;
	g.font = '11px system-ui, sans-serif';
	g.textAlign = 'center';
	for (let x = gridStart; x <= view.x1; x += step) {
		if (px(x) < GUTTER + 40) continue;
		g.fillText(`${x}  (${(x * ref.head.interval).toFixed(2)} s)`, px(x), ay + 12);
	}
	g.textAlign = 'left';
	g.fillText('tick from the reference\'s timer start', 8, ay + 12);
	drawHover();
}

function drawHover() {
	const g = over.getContext('2d');
	const r0 = window.devicePixelRatio || 1;
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.clearRect(0, 0, over.width, over.height);
	g.setTransform(r0, 0, 0, r0, 0, 0);
	drawPathHover();
	const box = $('readout');
	if (hoverX === null || !shown.length) {
		box.innerHTML = '<span class="k">Hover the graph for values.</span>';
		holdHeight(box, shown.length);
		return;
	}
	const last = lanes[lanes.length - 1];
	const X = Math.round(px(hoverX)) + 0.5;
	g.strokeStyle = C.hover;
	g.lineWidth = 1;
	g.beginPath();
	g.moveTo(X, 0);
	g.lineTo(X, last.y + last.h);
	g.stroke();
	box.replaceChildren();
	for (const r of shown) {
		const i = ghostNearest(r.gd.x, r.order, hoverX, 0.5);
		const d = r.gd;
		const row = document.createElement('span');
		const sw = `<span style="color:${r.color}">■</span>`;
		if (i < 0) {
			row.innerHTML = `${sw} <span class="k">no row here</span>`;
		} else {
			const j = r.jumps.find((jj) => i >= jj.s && i < jj.e);
			const where = d.ground[i] ? 'ground' : j ? (j.num ? `jump ${j.num}` : 'pre-jump') : 'air';
			const own = d.tick[i] - d.tick[Math.min(r.head.preRows || 0, d.n - 1)];
			row.innerHTML =
				`${sw} <span class="k">own tick</span> ${own} · ${where} · <span class="k">speed</span> ${f(d.speed[i], 1)} · ` +
				`<span class="k">gain</span> ${f(d.gain[i], 3)} / ${f(d.ideal[i], 3)} · <span class="k">yaw avg</span> ${f(d.yaws[i], 2)} · <span class="k">ratio</span> ${f(d.ratio[i], 3)}`;
		}
		box.append(row);
	}
	holdHeight(box, shown.length);
}

// ---------- top-down path ----------

let pathFit = null; // { s, ox, oy }: how the last path drawing maps world units to pixels
let pathView = null; // { s, cx, cy }: zoomed/panned path (scale, world centre); null = fit to the graph's ticks
// One recording is the focus (red-green gain, numbers) and one the comparison (own colour, dark to bright,
// numbers); the rest are plain. Ids; the defaults are the reference and the second pick.
let pathFocus = null;
let pathCmp = null;
const PATH_WHOLE_KEY = 'strafe-review-path-whole'; // shared with the main page

// Rows of a recording the path fits and draws bright: those in the graph's ticks (by aligned tick), or
// all with "Whole path". Rows the per-jump alignment squeezed out have no tick: they are drawn dimmed.
function pathIn(r) {
	if ($('path-whole').checked) return () => true;
	return (i) => r.gd.x[i] >= view.x0 && r.gd.x[i] <= view.x1;
}

// Same scale as the main page, drill page and in-game line: red at 60 % and under, green at 95 % and over
function gainColor(p) {
	if (!Number.isFinite(p)) return C.muted;
	const t = Math.max(0, Math.min(1, (p - 60) / 35));
	const mix = (a, b) => Math.round(a + (b - a) * t);
	return `rgb(${mix(0xff, 0x7b)},${mix(0x5c, 0xd8)},${mix(0x5c, 0x8f)})`;
}

// Focus / Compare buttons per recording, above the path. Picking the other role's recording swaps them.
function showPathRoles() {
	const box = $('path-roles');
	box.replaceChildren();
	for (const r of shown) {
		const row = document.createElement('span');
		row.className = 'role';
		const sw = document.createElement('span');
		sw.className = 'sw';
		sw.style.background = r.color;
		const t = document.createElement('span');
		t.textContent = `${labelText(r.head)} · ${when(r.head.started)}`;
		const btn = (text, on, pick) => {
			const b = document.createElement('button');
			b.textContent = text;
			b.classList.toggle('on', on);
			b.onclick = () => {
				pick();
				showPathRoles();
				draw();
			};
			return b;
		};
		const f = btn('Focus', r.id === pathFocus, () => {
			if (pathCmp === r.id) pathCmp = pathFocus;
			pathFocus = r.id;
		});
		const c = btn('Compare', r.id === pathCmp, () => {
			if (pathFocus === r.id) pathFocus = pathCmp;
			pathCmp = pathCmp === r.id ? null : r.id;
		});
		c.title = 'Click again for none';
		row.append(sw, t, f, c);
		box.append(row);
	}
}

function drawPath() {
	const box = $('path-box');
	const W = box.clientWidth;
	const H = box.clientHeight;
	const g = size($('path-base'), W, H);
	size($('path-over'), W, H);
	pathFit = null;
	$('path-dist').replaceChildren();
	g.font = '12px system-ui, sans-serif';
	g.fillStyle = C.muted;
	if (!shown.length) {
		g.fillText('Pick recordings above.', 12, 22);
		return;
	}
	let x0 = Infinity;
	let x1 = -Infinity;
	let y0 = Infinity;
	let y1 = -Infinity;
	const ins = shown.map(pathIn);
	for (const [k, r] of shown.entries()) {
		const { x, y } = r.path;
		for (let i = 0; i < r.d.n; i++) {
			if (!Number.isFinite(x[i]) || !ins[k](i)) continue;
			x0 = Math.min(x0, x[i]);
			x1 = Math.max(x1, x[i]);
			y0 = Math.min(y0, y[i]);
			y1 = Math.max(y1, y[i]);
		}
	}
	if (!Number.isFinite(x0)) {
		g.fillText('No path for these ticks.', 12, 22);
		return;
	}
	const PAD = 24;
	// world y points up, so it is flipped on the canvas; at least 64 units across, so a standstill doesn't blow up
	const v = pathView || {
		s: Math.min((W - 2 * PAD) / Math.max(x1 - x0, 64), (H - 2 * PAD) / Math.max(y1 - y0, 64)),
		cx: (x0 + x1) / 2,
		cy: (y0 + y1) / 2
	};
	const s = v.s;
	const ox = W / 2 - v.cx * s;
	const oy = H / 2 + v.cy * s;
	$('path-reset').disabled = !pathView;
	pathFit = { s, ox, oy };
	for (const r of shown) {
		const p = Math.min(r.head.preRows || 0, r.d.n - 1);
		const span = document.createElement('span');
		span.innerHTML = `<span style="color:${r.color}">■</span> ${Math.round(pathDistance(r.path, p, r.stats.endIdx))} `;
		$('path-dist').append(span);
	}
	$('path-dist').append('units');
	g.lineCap = 'round';
	g.lineJoin = 'round';
	// plain ones first, then the comparison, the focus on top; dimmed rows under the bright ones
	const role = (r) => (r.id === pathFocus ? 2 : r.id === pathCmp ? 1 : 0);
	const order = [...shown.keys()].sort((a, b) => role(shown[a]) - role(shown[b]) || b - a);
	const colOf = (r) => {
		const k = role(r);
		if (!k) return () => r.color;
		const pct = r.path.pct;
		return k === 2 ? (i) => (r.d.ground[i] ? C.muted : gainColor(pct[i])) : (i) => gainShade(r.d.ground[i] ? NaN : pct[i], r.color);
	};
	for (const dim of [true, false]) {
		for (const k of order) {
			const r = shown[k];
			const { x, y, brk } = r.path;
			const col = colOf(r);
			const rk = role(r);
			// one stroke per run of rows with the same colour
			let run = null;
			const flush = () => {
				if (!run) return;
				g.strokeStyle = run;
				g.stroke();
				run = null;
			};
			g.globalAlpha = dim ? 0.22 : rk ? 1 : 0.7;
			g.lineWidth = dim ? 1.5 : rk === 2 ? 3 : rk === 1 ? 2.4 : 1.6;
			for (let i = 1; i < r.d.n; i++) {
				if (brk[i] || !Number.isFinite(x[i]) || !Number.isFinite(x[i - 1]) || !ins[k](i) !== dim) {
					flush();
					continue;
				}
				const c = col(i);
				if (run !== c) {
					flush();
					run = c;
					g.beginPath();
					g.moveTo(ox + x[i - 1] * s, oy - y[i - 1] * s);
				}
				g.lineTo(ox + x[i] * s, oy - y[i] * s);
			}
			flush();
		}
	}
	g.globalAlpha = 1;
	// takeoffs with jump numbers: the focus's on the right in white, the comparison's on the left in its colour
	g.font = '600 11px system-ui, sans-serif';
	for (const [k, r] of shown.entries()) {
		const rk = role(r);
		if (!rk) continue;
		const { x, y } = r.path;
		const tk = r.jumps.filter((j) => j.num && j.s <= r.stats.endIdx && ins[k](j.s) && Number.isFinite(x[j.s]));
		g.fillStyle = rk === 2 ? C.text : r.color;
		g.textAlign = rk === 2 ? 'left' : 'right';
		for (const j of tk) {
			const X = ox + x[j.s] * s;
			const Y = oy - y[j.s] * s;
			g.beginPath();
			g.arc(X, Y, 3, 0, 2 * Math.PI);
			g.fill();
			if (tk.length <= 40) g.fillText(String(j.num), rk === 2 ? X + 5 : X - 5, Y - 5);
		}
	}
	g.textAlign = 'left';
	// timer start (every path's (0, 0)) and each run end in its colour
	const ring = (X, Y, col, text) => {
		g.strokeStyle = col;
		g.lineWidth = 2;
		g.beginPath();
		g.arc(X, Y, 6, 0, 2 * Math.PI);
		g.stroke();
		g.fillStyle = col;
		g.fillText(text, X + 9, Y + 14);
	};
	ring(ox, oy, C.opt, 'timer start');
	for (const [k, r] of shown.entries()) {
		const e = r.stats.endIdx;
		if (!ins[k](e) || !Number.isFinite(r.path.x[e])) continue;
		ring(ox + r.path.x[e] * s, oy - r.path.y[e] * s, r.color, r.head.reason === 'finish' ? 'finish' : 'end');
	}
	// scale bar
	const unit = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((u) => u * s >= 60) || 10000;
	g.strokeStyle = C.text;
	g.lineWidth = 2;
	g.beginPath();
	g.moveTo(12, H - 12);
	g.lineTo(12 + unit * s, H - 12);
	g.stroke();
	g.fillStyle = C.muted;
	g.font = '11px system-ui, sans-serif';
	g.fillText(`${unit} units`, 12, H - 18);
}

// A dot with the view direction on each path, at the row the graph cursor pairs it with
function drawPathHover() {
	const cv = $('path-over');
	const g = cv.getContext('2d');
	const r0 = window.devicePixelRatio || 1;
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.clearRect(0, 0, cv.width, cv.height);
	g.setTransform(r0, 0, 0, r0, 0, 0);
	if (hoverX === null || !pathFit) return;
	const { s, ox, oy } = pathFit;
	for (let k = shown.length - 1; k >= 0; k--) {
		const r = shown[k];
		const i = ghostNearest(r.gd.x, r.order, hoverX, 0.5);
		if (i < 0 || !Number.isFinite(r.path.x[i])) continue;
		const X = ox + r.path.x[i] * s;
		const Y = oy - r.path.y[i] * s;
		const a = (r.d.yaw[i] * Math.PI) / 180 + r.path.turn;
		g.strokeStyle = r.color;
		g.lineWidth = 2;
		g.beginPath();
		g.moveTo(X, Y);
		g.lineTo(X + Math.cos(a) * 20, Y - Math.sin(a) * 20);
		g.stroke();
		g.fillStyle = r.color;
		g.beginPath();
		g.arc(X, Y, k === 0 ? 5 : 4, 0, 2 * Math.PI);
		g.fill();
		g.strokeStyle = C.hover;
		g.lineWidth = 1;
		g.stroke();
	}
}

// Nearest row to a point on the path canvas, within 14 px, over all recordings: { r, i } or null. Only
// rows with a graph tick count (squeezed-out rows have nothing to put the cursor on); among those, the
// ones the path fits, or any once zoomed/panned.
function pathRowAt(mx, my) {
	if (!pathFit) return null;
	const { s, ox, oy } = pathFit;
	let best = null;
	let bd = 14 * 14;
	for (const r of shown) {
		const inside = pathView ? () => true : pathIn(r);
		for (const i of r.order) {
			if (!Number.isFinite(r.path.x[i]) || !inside(i)) continue;
			const dx = ox + r.path.x[i] * s - mx;
			const dy = oy - r.path.y[i] * s - my;
			if (dx * dx + dy * dy < bd) {
				bd = dx * dx + dy * dy;
				best = { r, i };
			}
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
	if (!pathFit) return;
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
	if (e.button !== 0 || !pathFit) return;
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
	const hit = pathRowAt(e.clientX - rect.left, e.clientY - rect.top);
	hoverX = hit ? hit.r.gd.x[hit.i] : null;
	drawHover();
});
$('path-over').addEventListener('mouseleave', () => {
	hoverX = null;
	drawHover();
});
// Click: zoom the graph to that jump (in every recording), or centre it on that tick on the ground
$('path-over').addEventListener('click', (e) => {
	if (pathDrag?.moved) return;
	const rect = e.currentTarget.getBoundingClientRect();
	const hit = pathRowAt(e.clientX - rect.left, e.clientY - rect.top);
	if (!hit) return;
	const { r, i } = hit;
	const j = r.jumps.find((jj) => i >= jj.s && i < jj.e);
	const x = r.gd.x[i];
	if (j && j.num) zoomToJump(j.num);
	else {
		const span = view.x1 - view.x0;
		view = { x0: x - span / 2, x1: x + span / 2 };
		draw();
	}
	hoverX = x;
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

over.addEventListener('mousemove', (e) => {
	if (!shown.length) return;
	const mx = e.clientX - over.getBoundingClientRect().left;
	if (drag) {
		const dx = ((mx - drag.mx) / plotW()) * (drag.x1 - drag.x0);
		if (Math.abs(mx - drag.mx) > 3) drag.moved = true;
		view = { x0: drag.x0 - dx, x1: drag.x1 - dx };
		draw();
	}
	hoverX = mx >= GUTTER ? xAt(mx) : null;
	drawHover();
});
over.addEventListener('mouseleave', () => {
	hoverX = null;
	drawHover();
});
over.addEventListener('mousedown', (e) => {
	if (!shown.length) return;
	drag = { mx: e.clientX - over.getBoundingClientRect().left, x0: view.x0, x1: view.x1, moved: false };
});
window.addEventListener('mouseup', (e) => {
	if (!drag) return;
	const moved = drag.moved;
	drag = null;
	if (moved || !shown.length) return;
	const rect = over.getBoundingClientRect();
	const y = e.clientY - rect.top;
	const l = lanes.find((ll) => y >= ll.y && y < ll.y + ll.h);
	if (!l || l.id !== 'jumps') return;
	// zoom to the reference's jump under the pointer, wide enough to hold the others' matching jumps
	const x = xAt(e.clientX - rect.left);
	const ref = shown[0];
	const j = ref.jumps.find((jj) => jj.num && x >= jj.x0 - 0.5 && x <= jj.x1 + 0.5);
	if (j) zoomToJump(j.num);
});
over.addEventListener(
	'wheel',
	(e) => {
		if (!shown.length) return;
		e.preventDefault();
		const at = xAt(e.clientX - over.getBoundingClientRect().left);
		const k = Math.exp(e.deltaY * 0.0015);
		const full = fullRange();
		const span = Math.min(Math.max((view.x1 - view.x0) * k, 20), full.x1 - full.x0);
		const t = (at - view.x0) / (view.x1 - view.x0);
		view = { x0: at - t * span, x1: at - t * span + span };
		draw();
	},
	{ passive: false }
);
over.addEventListener('dblclick', whole);

function zoomToJump(num) {
	let lo = Infinity;
	let hi = -Infinity;
	for (const r of shown) {
		const j = r.jumps.find((jj) => jj.num === num);
		if (!j) continue;
		for (let i = j.s; i < Math.min(j.e, r.stats.endIdx + 1); i++) {
			const x = r.gd.x[i];
			if (!Number.isFinite(x)) continue;
			lo = Math.min(lo, x);
			hi = Math.max(hi, x);
		}
	}
	if (Number.isFinite(lo)) zoomTo(lo, hi);
}

$('whole').onclick = whole;
$('jump1').onclick = () => zoomToJump(1);
$('align').value = localStorage.getItem(ALIGN_KEY) === 'timer' ? 'timer' : 'jump';
$('align').onchange = () => {
	localStorage.setItem(ALIGN_KEY, $('align').value);
	build();
};
$('map').onchange = () => {
	picks = [];
	changed();
};
$('clear').onclick = () => {
	picks = [];
	changed();
};
$('show-drills').checked = localStorage.getItem(DRILLS_KEY) === '1';
$('show-drills').onchange = () => {
	localStorage.setItem(DRILLS_KEY, $('show-drills').checked ? '1' : '0');
	showPicker();
};
$('search').oninput = showPicker;
initSort($('sort'), SORT_KEY, showPicker);
new ResizeObserver(() => draw()).observe($('plot'));
addEventListener('scroll', hideRsTip, { passive: true });

// ---------- section pictures ----------

// Copy / Save buttons (snap.js): each picture has the map and alignment on top, then the section (the
// graph's and path's keep their legend of which colour is which recording)
{
	const mapText = () => $('map').selectedOptions[0]?.text || '';
	const caption = () => `Compare · ${mapText()} · ${$('align').selectedOptions[0].text.toLowerCase()}`;
	for (const [id, part] of [['stats', 'stats'], ['graph', 'graph'], ['path-sec', 'path']]) {
		const head = $(id).querySelector('.sec-head');
		// the graph's go next to Whole run / Jump 1, before the alignment note that fills the line
		head.insertBefore(snapButtons(part, () => (shown.length >= 2 ? [caption(), $(id)] : null), () => `${mapText()} · compare ${part}`), head.querySelector('.align-tip'));
	}
}

const es = new EventSource('/api/events');
es.onopen = () => $('live').classList.remove('off');
es.onerror = () => $('live').classList.add('off');
es.addEventListener('attempt', loadList);

Promise.all([
	loadList(),
	fetch('/api/mouse')
		.then((r) => r.json())
		.then((v) => (mouseNow = v))
		.catch(() => {})
]).then(() => {
	dpi = loadDpi() ?? dpiFromHeads(list);
	// #<map>/<id>,<id>,...: the map comes from the first id that is still saved
	const [dir, ids] = location.hash.slice(1).split('/');
	const want = (ids || '').split(',').filter(Boolean);
	const first = list.find((h) => h.dir === dir && want.includes(h.id));
	if (first) {
		$('map').value = mapKey(first);
		picks = want.filter((id) => list.some((h) => h.id === id && mapKey(h) === mapKey(first))).slice(0, MAX_PICKS);
	}
	changed();
});
