'use strict';
// Strafe Review: jump-1 drill page. Jump 1 of every own attempt in a session, stacked on one set of
// lanes (aligned on takeoff) and side by side as cards, with best, median and spread.
// The server pushes an "attempt" event (/api/events) when the collector saves one, so the page
// updates by itself while you play.

const C = {
	grid: '#3a4152',
	text: '#e6e9ef',
	muted: '#a3abba',
	all: '#4fc3f733',
	best: '#7bd88f',
	last: '#6c9cff',
	med: '#ffffff',
	rep: '#ffb454',
	hover: '#ffe066',
	bad: '#ff5c5c'
};
const SESSION_GAP = 30 * 60 * 1000; // ms between attempt starts that ends a session
const SETTINGS_KEY = 'strafe-review-checks'; // the main page's check settings
const GUTTER = 92;
const LANES = [
	{ id: 'speed', title: 'Speed', unit: 'u/s', h: 170 },
	{ id: 'turn', title: 'Turn speed', unit: '°/tick', h: 130 },
	{ id: 'lost', title: 'Lost so far', unit: 'u/s', h: 110 }
];
const LANE_GAP = 10;
const AXIS_H = 26;

const $ = (id) => document.getElementById(id);
let list = []; // attempt headers from /api/attempts
const cache = new Map(); // "dir/id" -> entry (parsed jump 1), or null when it has none
const TAG_KEY = 'strafe-review-drill-tag';
let followLatest = true; // the map picker follows the newest attempt until it's changed by hand
let shown = { own: [], replays: [] }; // entries on the page now
let fresh = new Set(); // keys that arrived live, flashed once
let hoverKey = null;
let renderToken = 0;
let focusKey = null; // attempt picked for the focus panel; null = the latest
let mouseNow = null; // the game's sensitivity and m_yaw now (/api/mouse), for attempts that didn't record theirs
let dpi = null; // mouse DPI typed in (mouse.js), or pre-filled from what Momentum stored

const key = (h) => `${h.dir}/${h.id}`;
const mapKey = (h) => `${h.dir}|${h.interval}`;

function quant(vs, q) {
	if (!vs.length) return NaN;
	const s = [...vs].sort((a, b) => a - b);
	const p = (s.length - 1) * q;
	const lo = Math.floor(p);
	return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (p - lo);
}

function when(ms) {
	return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
		.filter((a) => a.dir === h.dir && a.interval === h.interval && !isOther(a) && a.id !== h.id && a.j1Takeoff >= MIN_TAKEOFF)
		.map((a) => a.j1Takeoff);
	return vs.length ? { takeoffMedian: median(vs), takeoffRuns: vs.length } : null;
}

// ---------- data ----------

// Jump 1 of one attempt, its rows put on ticks from takeoff. null when the attempt has no jump 1.
async function entry(h) {
	const k = key(h);
	if (cache.has(k)) return cache.get(k);
	const res = await fetch(`/api/attempt/${encodeURIComponent(h.dir)}/${encodeURIComponent(h.id)}`);
	if (!res.ok) return null;
	const a = await res.json();
	const d = parse(a);
	const { jumps, j1 } = findJumps(d, a.preRows);
	let e = null;
	if (j1 >= 0) {
		const endIdx = a.postRows ? d.n - 1 - a.postRows : d.n - 1;
		const j = jumps[j1];
		// Cut short: the run ended (reset, fail) before jump 1 landed
		const complete = j.e <= endIdx && j.e < d.n;
		const last = Math.min(j.e, endIdx + 1) - 1;
		const t0 = d.x[j.s];
		const xs = [];
		const speed = [];
		const turn = [];
		const lost = [];
		let sum = 0;
		for (let i = j.s; i <= last; i++) {
			xs.push(d.x[i] - t0);
			speed.push(i > j.s && d.gap[i] > 0 ? NaN : d.speed[i]);
			turn.push(d.yaws[i]);
			const l = d.ideal[i] - d.gain[i];
			// same rows the checks judge: 100+ u/s, no collision ticks
			if (Number.isFinite(l) && d.speed[i] > 100 && !(d.gain[i] < -10)) sum += l;
			lost.push(sum);
		}
		const mistakes = runChecks(d, jumps, endIdx, loadSettings(), takeoffBaseline(h), isOther(h))
			.filter((m) => m.jump === 1)
			.map((m) => ({ ...m, x0: d.x[m.i0] - t0, x1: d.x[m.i1] - t0 }));
		const keys = [];
		const want = [];
		const opt = [];
		const btn = [];
		for (let i = j.s; i <= last; i++) {
			keys.push(keyDir(d.buttons[i]));
			want.push(d.ideal_key[i]);
			opt.push(d.opt[i]);
			btn.push(turnBtn(d, i) ? 1 : 0);
		}
		e = {
			h,
			k,
			complete,
			xs,
			speed,
			turn,
			lost,
			ticks: xs[xs.length - 1],
			takeoff: d.speed[j.s],
			land: d.speed[last],
			pct: j.pct,
			ssj: j.ssj,
			lostTotal: sum,
			mistakes,
			keys,
			want,
			opt,
			btn,
			strafes: strafeStats(d, j, endIdx, t0)
		};
	}
	cache.set(k, e);
	return e;
}

// Per strafe of jump 1: gain %, speed lost, angle (median yawRatio, ends and +left/+right ticks
// skipped), share of ticks with the matching key, and the key switch offset from the reversal
function strafeStats(d, j, endIdx, t0) {
	const sts = strafesOf(d, j, endIdx);
	const sw = switchesOf(d, j, endIdx);
	return sts.map((st, k) => {
		let g = 0;
		let id = 0;
		let ok = 0;
		const rs = [];
		for (let i = st.i0; i <= st.i1; i++) {
			if (strafing(d, i) && Number.isFinite(d.gain[i]) && Number.isFinite(d.ideal[i])) {
				g += d.gain[i];
				id += d.ideal[i];
			}
			if (!turnBtn(d, i) && i >= st.i0 + 2 && i <= st.i1 - 2 && Number.isFinite(d.ratio[i])) rs.push(d.ratio[i]);
			if (keyDir(d.buttons[i]) === st.dir) ok++;
		}
		let off = null;
		if (k > 0 && !st.gap && !sts[k - 1].gap)
			for (const w of sw) {
				const o = d.tick[w.i] - d.tick[st.i0];
				if (w.dir === st.dir && Math.abs(o) <= SWITCH_WINDOW && (off === null || Math.abs(o + 1) < Math.abs(off + 1))) off = o;
			}
		return {
			num: k + 1,
			dir: st.dir,
			x0: d.x[st.i0] - t0,
			x1: d.x[st.i1] - t0,
			n: st.n,
			lost: Math.max(id - g, 0),
			pct: id > 0 ? (100 * g) / id : NaN,
			ratio: median(rs),
			keys: (100 * ok) / (st.i1 - st.i0 + 1),
			sw: off,
			btn: st.btn > 0,
			turnDeg: strafeTurn(d, st)
		};
	});
}

function maps() {
	const out = new Map();
	for (const h of list) if (!out.has(mapKey(h))) out.set(mapKey(h), h); // list is newest first
	return out;
}

// Own attempts on the picked map, either the latest session or all, oldest first
function pick() {
	const mk = $('map').value;
	const tag = $('tag').value;
	const own = list
		.filter((h) => mapKey(h) === mk && !isOther(h) && (!tag || allTags(h).includes(tag)))
		.sort((a, b) => a.started - b.started);
	// A replay that starts over is recorded again (a few ticks before it was stopped): keep the
	// longest recording of each replay file
	const byFile = new Map();
	for (const h of list.filter((x) => mapKey(x) === mk && isOther(x))) {
		const f = h.replayFile || h.id;
		if (!byFile.has(f) || h.rowCount > byFile.get(f).rowCount) byFile.set(f, h);
	}
	const replays = [...byFile.values()];
	if ($('scope').value === 'all' || !own.length) return { own, replays };
	let from = own.length - 1;
	while (from > 0 && own[from].started - own[from - 1].started < SESSION_GAP) from--;
	return { own: own.slice(from), replays };
}

async function loadList() {
	list = await (await fetch('/api/attempts')).json();
	const sel = $('map');
	const old = sel.value;
	const ms = maps();
	sel.replaceChildren();
	for (const [mk, h] of ms) {
		const o = document.createElement('option');
		o.value = mk;
		o.textContent = `${h.dir} · ${Math.round(1 / h.interval)} tick`;
		sel.append(o);
	}
	// follow the newest attempt's map unless one was picked by hand
	if (!followLatest && ms.has(old)) sel.value = old;
	else if (ms.size) sel.value = ms.keys().next().value;
	autoTags(list);
	fillTags();
}

// Tags (own and automatic) of own attempts on the picked map. A picked tag the map doesn't have shows as All.
function fillTags() {
	const sel = $('tag');
	const want = sel.value || localStorage.getItem(TAG_KEY) || '';
	const mk = $('map').value;
	const tags = [...new Set(list.filter((h) => mapKey(h) === mk && !isOther(h)).flatMap(allTags))].sort((a, b) => a.localeCompare(b));
	sel.replaceChildren(new Option('All', ''), ...tags.map((t) => new Option(t, t)));
	sel.value = tags.includes(want) ? want : '';
	sel.disabled = !tags.length;
}

async function render() {
	const token = ++renderToken;
	const { own, replays } = pick();
	const ownE = (await Promise.all(own.map(entry))).filter(Boolean);
	// a replay is only a reference when its jump 1 landed in the recording
	const repE = (await Promise.all(replays.map(entry))).filter((e) => e && e.complete);
	if (token !== renderToken) return; // a newer render started meanwhile
	shown = { own: ownE, replays: repE };
	if (focusKey && !ownE.some((e) => e.k === focusKey)) focusKey = null;
	showFocus();
	showStats();
	drawTrend();
	drawStack();
	showCards();
	fresh = new Set();
}

// ---------- stats ----------

function stat(label, value, note, onclick) {
	const el = document.createElement(onclick ? 'button' : 'div');
	el.className = 'stat';
	const l = document.createElement('div');
	l.className = 'label';
	l.textContent = label;
	const v = document.createElement('div');
	v.className = 'value';
	v.textContent = value;
	el.append(l, v);
	if (note) {
		const n = document.createElement('div');
		n.className = 'note';
		n.textContent = note;
		el.append(n);
	}
	if (onclick) el.onclick = onclick;
	return el;
}

function best(es) {
	return es.reduce((b, e) => (!b || e.land > b.land ? e : b), null);
}

function openMain(e) {
	location.href = `/#${e.h.dir}/${e.h.id}/j1`;
}

function showStats() {
	const box = $('stats');
	box.replaceChildren();
	const all = shown.own;
	const done = all.filter((e) => e.complete);
	if (!done.length) {
		box.textContent = all.length ? 'Every jump 1 here was cut short by the run ending before the landing.' : 'No own attempts with a jump 1 on this map yet.';
		return;
	}
	const lands = done.map((e) => e.land);
	const pcts = done.map((e) => e.pct).filter(Number.isFinite);
	const b = best(done);
	const cut = all.length - done.length;
	const iqr = (vs) => quant(vs, 0.75) - quant(vs, 0.25);
	const grid = document.createElement('div');
	grid.className = 'stat-grid';
	grid.append(
		stat('Attempts', `${done.length}`, cut ? `+${cut} cut short (not counted)` : 'all landed'),
		stat('Best landing', `${b.land.toFixed(1)} u/s`, `gain ${b.pct.toFixed(2)} % · ${when(b.h.started)} · open`, () => openMain(b)),
		stat('Median landing', `${median(lands).toFixed(1)} u/s`, `takeoff median ${median(done.map((e) => e.takeoff)).toFixed(1)} u/s`),
		stat('Consistency', `±${(iqr(lands) / 2).toFixed(1)} u/s`, `landing IQR ${iqr(lands).toFixed(1)} u/s (middle half of attempts)`),
		stat('Median gain', `${median(pcts).toFixed(2)} %`, `IQR ${iqr(pcts).toFixed(2)} % points`)
	);
	if (done.length >= 8) {
		const recent = done.slice(-5).map((e) => e.land);
		const diff = median(recent) - median(lands);
		grid.append(stat('Last 5', `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} u/s`, `median landing of the last 5 vs all shown`));
	}
	box.append(grid);

	// Which checks fire on jump 1 most often, and what they cost
	const by = new Map();
	for (const e of done)
		for (const m of e.mistakes) {
			const s = by.get(m.check) || { name: m.name, runs: new Set(), lost: 0 };
			s.runs.add(e.k);
			s.lost += m.lost;
			by.set(m.check, s);
		}
	const top = [...by.values()].sort((x, y) => y.runs.size - x.runs.size || y.lost - x.lost);
	const p = document.createElement('div');
	p.className = 'common';
	const head = document.createElement('b');
	head.textContent = 'Most common jump-1 mistakes: ';
	p.append(head);
	p.append(
		top.length
			? top
					.slice(0, 4)
					.map((s) => `${s.name} in ${s.runs.size} of ${done.length} (${(s.lost / s.runs.size).toFixed(1)} u/s each)`)
					.join(' · ')
			: 'none with the current check settings'
	);
	box.append(p);
	for (const r of shown.replays) {
		const n = document.createElement('div');
		n.className = 'muted';
		n.textContent = `Reference: ${whoseRun(r.h)}, landing ${r.land.toFixed(1)} u/s, gain ${r.pct.toFixed(2)} % (not counted)`;
		box.append(n);
	}
}

// ---------- canvas helpers ----------

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

function niceStep(span, px, minPx) {
	for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000]) if ((s / span) * px >= minPx) return s;
	return 1000;
}

function gainColor(p) {
	if (!Number.isFinite(p)) return C.muted;
	const t = Math.max(0, Math.min(1, (p - 60) / 35));
	const mix = (a, b) => Math.round(a + (b - a) * t);
	return `rgb(${mix(0xff, 0x7b)},${mix(0x5c, 0xd8)},${mix(0x5c, 0x8f)})`;
}

function polyline(g, xs, ys, X, Y, color, width, dash) {
	g.strokeStyle = color;
	g.lineWidth = width;
	g.setLineDash(dash || []);
	g.beginPath();
	let pen = false;
	for (let i = 0; i < xs.length; i++) {
		if (!Number.isFinite(ys[i])) {
			pen = false;
			continue;
		}
		if (pen) g.lineTo(X(xs[i]), Y(ys[i]));
		else g.moveTo(X(xs[i]), Y(ys[i]));
		pen = true;
	}
	g.stroke();
	g.setLineDash([]);
}

// ---------- trend ----------

let trendHits = []; // [x, y, entry]

function drawTrend() {
	const box = $('trend-box');
	const w = box.clientWidth;
	const h = 150;
	const g = size($('trend'), w, h);
	trendHits = [];
	const es = shown.own;
	const done = es.filter((e) => e.complete);
	if (!done.length) return;
	const lo = Math.floor(Math.min(...done.map((e) => e.land)) / 10) * 10 - 5;
	const hi = Math.ceil(Math.max(...done.map((e) => e.land)) / 10) * 10 + 5;
	const L = 56;
	const R = 14;
	const X = (i) => L + ((i + 0.5) / es.length) * (w - L - R);
	const Y = (v) => 10 + (1 - (v - lo) / (hi - lo)) * (h - 30);
	g.font = '12px system-ui';
	g.fillStyle = C.muted;
	g.textAlign = 'right';
	const step = niceStep(hi - lo, h - 30, 24);
	for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
		g.strokeStyle = C.grid;
		g.lineWidth = 1;
		g.beginPath();
		g.moveTo(L, Y(v));
		g.lineTo(w - R, Y(v));
		g.stroke();
		g.fillText(`${v}`, L - 6, Y(v) + 4);
	}
	const med = median(done.map((e) => e.land));
	g.strokeStyle = C.med;
	g.setLineDash([5, 4]);
	g.beginPath();
	g.moveTo(L, Y(med));
	g.lineTo(w - R, Y(med));
	g.stroke();
	g.setLineDash([]);
	const b = best(done);
	es.forEach((e, i) => {
		const x = X(i);
		if (!e.complete) {
			// cut short: a hollow mark on the floor
			g.strokeStyle = C.muted;
			g.lineWidth = 1.5;
			g.strokeRect(x - 4, h - 24, 8, 8);
			trendHits.push([x, h - 20, e]);
			return;
		}
		const y = Y(e.land);
		g.fillStyle = gainColor(e.pct);
		g.beginPath();
		g.arc(x, y, e === b ? 7 : 5, 0, 2 * Math.PI);
		g.fill();
		if (e === b || e.k === hoverKey) {
			g.strokeStyle = e.k === hoverKey ? C.hover : C.text;
			g.lineWidth = 2;
			g.stroke();
		}
		trendHits.push([x, y, e]);
	});
}

function trendAt(ev) {
	const r = $('trend').getBoundingClientRect();
	const mx = ev.clientX - r.left;
	const my = ev.clientY - r.top;
	let got = null;
	let bestD = 14 * 14;
	for (const [x, y, e] of trendHits) {
		const dd = (x - mx) ** 2 + (y - my) ** 2;
		if (dd < bestD) {
			bestD = dd;
			got = e;
		}
	}
	return got;
}

// ---------- stacked ----------

let stackGeom = null; // { X, lanes: [{ id, top, h, Y }] }

function laneRange(id, es) {
	const vs = [];
	for (const e of es) for (const v of e[id]) if (Number.isFinite(v)) vs.push(v);
	if (!vs.length) return [0, 1];
	if (id === 'turn') {
		const m = Math.max(quant(vs.map(Math.abs), 0.99), 0.5);
		return [-m * 1.05, m * 1.05];
	}
	const lo = quant(vs, 0.005);
	const hi = quant(vs, 0.995);
	const pad = (hi - lo) * 0.05 || 1;
	return id === 'lost' ? [Math.min(0, lo), hi + pad] : [lo - pad, hi + pad];
}

// Median curve over the complete attempts, tick by tick from takeoff
function medianCurve(es, id, maxX) {
	const xs = [];
	const ys = [];
	for (let x = 0; x <= maxX; x++) {
		const vs = [];
		for (const e of es) {
			const i = e.xs.indexOf(x);
			if (i >= 0 && Number.isFinite(e[id][i])) vs.push(e[id][i]);
		}
		xs.push(x);
		ys.push(vs.length >= Math.max(2, es.length / 2) ? median(vs) : NaN);
	}
	return { xs, ys };
}

function drawStack() {
	const box = $('stack-box');
	const w = box.clientWidth;
	const total = LANES.reduce((t, l) => t + l.h + LANE_GAP, 0) + AXIS_H;
	const g = size($('stack'), w, total);
	const own = shown.own;
	const every = [...own, ...shown.replays];
	if (!every.length) {
		stackGeom = null;
		return;
	}
	const done = own.filter((e) => e.complete);
	const maxX = Math.max(...every.map((e) => e.ticks), 1);
	const X = (x) => GUTTER + (x / maxX) * (w - GUTTER - 12);
	const lanes = [];
	let top = 0;
	for (const l of LANES) {
		const [lo, hi] = laneRange(l.id, every);
		const t = top;
		lanes.push({ ...l, top: t, lo, hi, Y: (v) => t + 4 + (1 - (v - lo) / (hi - lo)) * (l.h - 8) });
		top += l.h + LANE_GAP;
	}
	stackGeom = { X, lanes, maxX };
	const b = best(done);
	const latest = own[own.length - 1];

	g.font = '12px system-ui';
	for (const l of lanes) {
		g.fillStyle = '#232733';
		g.fillRect(GUTTER, l.top, w - GUTTER - 12, l.h);
		g.strokeStyle = '#4a5468';
		g.lineWidth = 1;
		g.strokeRect(GUTTER + 0.5, l.top + 0.5, w - GUTTER - 13, l.h - 1);
		g.fillStyle = C.text;
		g.textAlign = 'left';
		g.fillText(l.title, 6, l.top + 16);
		g.fillStyle = C.muted;
		g.fillText(l.unit, 6, l.top + 31);
		g.textAlign = 'right';
		const step = niceStep(l.hi - l.lo, l.h, 26);
		for (let v = Math.ceil(l.lo / step) * step; v <= l.hi; v += step) {
			const y = l.Y(v);
			g.strokeStyle = v === 0 && l.id === 'turn' ? '#5a6478' : C.grid;
			g.beginPath();
			g.moveTo(GUTTER, y);
			g.lineTo(w - 12, y);
			g.stroke();
			g.fillText(`${+v.toFixed(1)}`, GUTTER - 6, y + 4);
		}
		g.save();
		g.beginPath();
		g.rect(GUTTER, l.top, w - GUTTER - 12, l.h);
		g.clip();
		for (const e of own) if (e !== b && e !== latest && e.k !== hoverKey) polyline(g, e.xs, e[l.id], X, l.Y, C.all, 1.2);
		for (const e of shown.replays) polyline(g, e.xs, e[l.id], X, l.Y, C.rep, 1.6, [6, 4]);
		if (done.length >= 2) {
			const m = medianCurve(done, l.id, maxX);
			polyline(g, m.xs, m.ys, X, l.Y, C.med, 1.6, [5, 4]);
		}
		if (latest && latest !== b) polyline(g, latest.xs, latest[l.id], X, l.Y, C.last, 2.2);
		if (b) polyline(g, b.xs, b[l.id], X, l.Y, C.best, 2.4);
		const hv = every.find((e) => e.k === hoverKey);
		if (hv) polyline(g, hv.xs, hv[l.id], X, l.Y, C.hover, 2.6);
		g.restore();
	}
	// tick axis
	g.fillStyle = C.muted;
	g.textAlign = 'center';
	const step = niceStep(maxX, w - GUTTER, 50);
	for (let x = 0; x <= maxX; x += step) g.fillText(`${x}`, X(x), top + 14);
	g.textAlign = 'left';
	g.fillText('ticks', 6, top + 14);
}

// The line closest to the pointer in the lane under it
function stackAt(ev) {
	if (!stackGeom) return null;
	const r = $('stack').getBoundingClientRect();
	const mx = ev.clientX - r.left;
	const my = ev.clientY - r.top;
	const l = stackGeom.lanes.find((ln) => my >= ln.top && my < ln.top + ln.h);
	if (!l || mx < GUTTER) return null;
	const x = Math.round(((mx - GUTTER) / ($('stack').clientWidth - GUTTER - 12)) * stackGeom.maxX);
	let got = null;
	let bestD = 12;
	for (const e of [...shown.own, ...shown.replays]) {
		const i = e.xs.indexOf(x);
		if (i < 0 || !Number.isFinite(e[l.id][i])) continue;
		const dd = Math.abs(l.Y(e[l.id][i]) - my);
		if (dd < bestD) {
			bestD = dd;
			got = { e, x, v: e[l.id][i], l };
		}
	}
	return got;
}

function label(e) {
	return isOther(e.h) ? whoseRun(e.h) : `${when(e.h.started)}`;
}

// ---------- cards ----------

function mini(cv, e, maxX, ranges) {
	const w = 280;
	const h = 96;
	const g = size(cv, w, h);
	g.fillStyle = '#1c1f26';
	g.fillRect(0, 0, w, h);
	const X = (x) => 4 + (x / maxX) * (w - 8);
	const sY = (v) => 4 + (1 - (v - ranges.speed[0]) / (ranges.speed[1] - ranges.speed[0])) * 52;
	const tY = (v) => 62 + (1 - (v - ranges.turn[0]) / (ranges.turn[1] - ranges.turn[0])) * 30;
	g.strokeStyle = C.grid;
	g.beginPath();
	g.moveTo(0, 59.5);
	g.lineTo(w, 59.5);
	g.moveTo(0, tY(0));
	g.lineTo(w, tY(0));
	g.stroke();
	polyline(g, e.xs, e.speed, X, sY, isOther(e.h) ? C.rep : C.text, 1.6);
	polyline(g, e.xs, e.turn, X, tY, '#c792ea', 1.3);
}

function showCards() {
	const box = $('cards');
	box.replaceChildren();
	const es = [...shown.own].reverse();
	if (!es.length) return;
	const every = [...shown.own, ...shown.replays];
	const maxX = Math.max(...every.map((e) => e.ticks), 1);
	const ranges = { speed: laneRange('speed', every), turn: laneRange('turn', every) };
	const b = best(shown.own.filter((e) => e.complete));
	es.forEach((e) => {
		const n = shown.own.indexOf(e) + 1;
		const card = document.createElement('button');
		card.className = `card${e === focused() ? ' focus' : ''}${e === b ? ' best' : ''}${fresh.has(e.k) ? ' fresh' : ''}${e.complete ? '' : ' cut'}`;
		card.dataset.key = e.k;
		const top = document.createElement('div');
		top.className = 'top';
		const t = document.createElement('b');
		t.textContent = `#${n} · ${when(e.h.started)}`;
		const tag = document.createElement('span');
		tag.className = 'chip reason';
		tag.textContent = e === b ? 'Best' : e.complete ? e.h.reason || '' : 'Cut short';
		if (e === b) tag.className = 'chip own';
		top.append(t, tag);
		const cv = document.createElement('canvas');
		const nums = document.createElement('div');
		nums.className = 'nums';
		nums.textContent = e.complete
			? `${e.takeoff.toFixed(0)} → ${e.land.toFixed(0)} u/s (${e.land >= e.takeoff ? '+' : ''}${(e.land - e.takeoff).toFixed(0)}) · gain ${e.pct.toFixed(2)} %${Number.isFinite(e.ssj) ? ` · CS:S ${e.ssj.toFixed(1)} %` : ''} · ${e.ticks} ticks`
			: `takeoff ${e.takeoff.toFixed(0)} u/s · run ended ${e.ticks} ticks in`;
		const m = document.createElement('div');
		m.className = 'worst';
		const w = e.mistakes[0];
		m.textContent = w ? `${w.name}: ${w.text} (${w.lost.toFixed(1)} u/s)` : 'No jump-1 mistakes found';
		if (!w) m.classList.add('none');
		card.append(top, cv, nums, m);
		mini(cv, e, maxX, ranges);
		card.onclick = () => setFocus(e.k);
		card.onmouseenter = () => setHover(e.k);
		card.onmouseleave = () => setHover(null);
		box.append(card);
	});
}

function setHover(k) {
	if (k === hoverKey) return;
	hoverKey = k;
	drawTrend();
	drawStack();
	for (const c of document.querySelectorAll('.card')) c.classList.toggle('hov', c.dataset.key === k);
}

// ---------- focus: one jump 1 against your usual ----------

const SIDE_NAME = { 1: 'left', '-1': 'right' };
const KEY_NAME = { 1: 'A', '-1': 'D' };
const FIX = {
	early: 'Hold the first strafe longer before turning the other way.',
	lateFirst: 'Press the strafe key the moment you leave the ground.',
	takeoff: 'Build more prestrafe speed before the jump.',
	wide: 'Turn the mouse slower in this strafe.',
	narrow: 'Turn the mouse faster in this strafe.',
	uneven: 'Keep one steady mouse speed through the strafe.',
	wrongKey: 'Hold the key on the side you are turning to.',
	noKey: 'Keep A or D held the whole time you turn.',
	switch: 'Switch keys 1 tick before you reverse the mouse.',
	wAir: 'Let go of W after takeoff.'
};

function focused() {
	const own = shown.own;
	return own.find((e) => e.k === focusKey) || own[own.length - 1] || null;
}

function setFocus(k) {
	const latest = shown.own[shown.own.length - 1];
	focusKey = latest && k === latest.k ? null : k;
	showFocus();
	showCards();
	$('focus').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// Your usual for strafe `num`: medians over the other landed attempts that have that strafe
function usual(f, num) {
	const sts = shown.own.filter((e) => e.complete && e !== f).map((e) => e.strafes[num - 1]).filter(Boolean);
	const m = (key) => median(sts.map((s) => s[key]).filter((v) => v !== null && Number.isFinite(v)));
	return { runs: sts.length, pct: m('pct'), lost: m('lost'), ratio: m('ratio'), keys: m('keys'), sw: m('sw'), n: m('n') };
}

// Plain-words reasons a strafe did worse than usual, strongest first
function strafeAdvice(s, u, m) {
	const out = [];
	if (Number.isFinite(s.ratio) && Number.isFinite(u.ratio)) {
		const t = s.turnDeg;
		const cm = m && t.ticks >= 5 ? ` (the optimal turn needed about ${cmText(t.opt, m)} of mouse there, you moved ${cmText(t.did, m)})` : '';
		if (s.ratio < u.ratio - 0.12) out.push(`you turned slower than usual (angle ${s.ratio.toFixed(2)}, usual ${u.ratio.toFixed(2)}): move the mouse faster${cm}`);
		else if (s.ratio > u.ratio + 0.12) out.push(`you turned faster than usual (angle ${s.ratio.toFixed(2)}, usual ${u.ratio.toFixed(2)}): move the mouse slower${cm}`);
	}
	if (Number.isFinite(u.keys) && s.keys < u.keys - 10) out.push(`${KEY_NAME[s.dir]} was held on only ${s.keys.toFixed(0)} % of its ticks (usual ${u.keys.toFixed(0)} %)`);
	if (s.sw !== null && (s.sw <= -3 || s.sw >= 1)) out.push(`you switched to ${KEY_NAME[s.dir]} ${Math.abs(s.sw)} tick${Math.abs(s.sw) === 1 ? '' : 's'} ${s.sw < 0 ? 'before' : 'after'} reversing the mouse (aim for 1 before)`);
	if (Number.isFinite(u.n) && s.n < u.n - 8) out.push(`it was short: ${s.n} ticks (usual ${u.n.toFixed(0)})`);
	if (s.btn) out.push('+left/+right was held in it');
	return out;
}

function el(tag, cls, text) {
	const x = document.createElement(tag);
	if (cls) x.className = cls;
	if (text !== undefined) x.textContent = text;
	return x;
}

function showFocus() {
	const box = $('focus-body');
	box.replaceChildren();
	const f = focused();
	const latest = shown.own[shown.own.length - 1];
	$('focus-title').textContent = !f ? 'Last jump 1' : f === latest ? 'Last jump 1' : `Jump 1 of #${shown.own.indexOf(f) + 1}`;
	$('focus-latest').hidden = !f || f === latest;
	$('focus-open').hidden = !f;
	if (!f) {
		box.textContent = 'No own attempt with a jump 1 here yet.';
		drawFocus();
		return;
	}
	const done = shown.own.filter((e) => e.complete && e !== f);
	const b = best(done);
	const m = mouseFor(f.h, mouseNow, dpi);
	const medLand = median(done.map((e) => e.land));

	// Verdict
	const v = el('div', 'verdict');
	const head = el('div', 'v-head');
	head.append(el('b', '', `${when(f.h.started)}`));
	if (f.complete) {
		head.append(` · ${f.takeoff.toFixed(0)} → ${f.land.toFixed(0)} u/s · gain ${f.pct.toFixed(2)} %${Number.isFinite(f.ssj) ? ` · CS:S ${f.ssj.toFixed(1)} %` : ''}`);
		if (Number.isFinite(medLand)) {
			const dm = f.land - medLand;
			head.append(el('span', dm >= 0 ? 'good' : 'bad', ` · ${dm >= 0 ? '+' : ''}${dm.toFixed(1)} vs your median`));
		}
		if (b) {
			const db = f.land - b.land;
			head.append(el('span', db >= 0 ? 'good' : 'muted', db >= 0 ? ' · new best' : ` · ${(-db).toFixed(1)} short of your best`));
		}
	} else head.append(` · takeoff ${f.takeoff.toFixed(0)} u/s · the run ended ${f.ticks} ticks in, before the landing`);
	v.append(head);

	// The strafe that lost the most compared with your usual for it
	let worst = null;
	for (const s of f.strafes) {
		const u = usual(f, s.num);
		if (u.runs < 3 || !Number.isFinite(u.lost)) continue;
		const extra = s.lost - u.lost;
		if (!worst || extra > worst.extra) worst = { s, u, extra };
	}
	const tips = [];
	if (worst && worst.extra > 3) {
		const why = strafeAdvice(worst.s, worst.u, m);
		tips.push([
			worst.extra,
			`Strafe ${worst.s.num} (${SIDE_NAME[worst.s.dir]}) lost ${worst.extra.toFixed(1)} u/s more than usual` +
				(why.length ? `: ${why.join('; ')}.` : '. Angle, keys and switch look normal there, so check its turn-speed line below.')
		]);
	}
	// Air time with no turn at all after the first strafe (strafing stopped before the landing)
	const s1 = f.strafes[0];
	for (let i = 0, a = -1; i <= f.xs.length; i++) {
		const idle = i < f.xs.length && !f.want[i] && s1 && f.xs[i] > s1.x1;
		if (idle && a < 0) a = i;
		if (!idle && a >= 0) {
			const n = f.xs[i - 1] - f.xs[a] + 1;
			if (n >= 8) {
				const lost = f.lost[i - 1] - (a > 0 ? f.lost[a - 1] : 0);
				tips.push([lost, `No turning for ${n} ticks (ticks ${f.xs[a]}–${f.xs[i - 1]}${i === f.xs.length && f.complete ? ', right up to the landing' : ''}), losing ${lost.toFixed(1)} u/s: keep strafing until you land.`]);
			}
			a = -1;
		}
	}
	const top = f.mistakes[0];
	if (top) tips.push([top.lost, `${top.name} (${top.lost.toFixed(1)} u/s): ${top.text}. ${FIX[top.check] || ''}`]);
	if (!tips.length) tips.push([0, f.complete ? 'Nothing stands out against your usual. Every strafe was within 3 u/s of it.' : 'Too short to judge.']);
	// biggest loss first
	tips.sort((x, y) => y[0] - x[0]);
	const ul = el('ul', 'tips');
	for (const [, t] of tips) ul.append(el('li', '', t));
	v.append(ul);
	box.append(v);

	// Per-strafe table
	if (f.strafes.length) {
		const t = el('table', 'strafes');
		const hr = el('tr');
		for (const h of ['Strafe', 'Ticks', 'Gain %', 'Lost u/s', 'Angle', 'Mouse', 'Key held', 'Switch', '']) hr.append(el('th', '', h));
		t.append(hr);
		const fmt = (x, dec = 0) => (x === null || !Number.isFinite(x) ? '–' : x.toFixed(dec));
		for (const s of f.strafes) {
			const u = usual(f, s.num);
			const tr = el('tr', worst && worst.s === s && worst.extra > 3 ? 'worst' : '');
			const cell = (val, us, dec, worse) => {
				const td = el('td');
				td.append(el('span', worse ? 'bad' : '', val));
				if (us !== undefined) td.append(el('span', 'us', ` ${us}`));
				return td;
			};
			// red only in a strafe that lost more than usual: a different angle that cost nothing isn't a mistake
			const lostWorse = Number.isFinite(u.lost) && s.lost - u.lost > 3;
			tr.append(
				el('td', '', `${s.num} ${SIDE_NAME[s.dir]}${s.btn ? ' (+left/right)' : ''}`),
				cell(`${s.n}`, fmt(u.n), 0, lostWorse && Number.isFinite(u.n) && s.n < u.n - 8),
				cell(fmt(s.pct, 2), fmt(u.pct, 2), 2, lostWorse && Number.isFinite(u.pct) && s.pct < u.pct - 10),
				cell(fmt(s.lost, 1), fmt(u.lost, 1), 1, lostWorse),
				cell(fmt(s.ratio, 2), fmt(u.ratio, 2), 2, lostWorse && Number.isFinite(u.ratio) && Math.abs(s.ratio - u.ratio) > 0.12),
				m && s.turnDeg.ticks ? cell(cmText(s.turnDeg.did, m), `opt ${cmText(s.turnDeg.opt, m)}`) : el('td', 'muted', '–'),
				cell(`${fmt(s.keys)} %`, fmt(u.keys), 0, lostWorse && Number.isFinite(u.keys) && s.keys < u.keys - 10),
				cell(s.sw === null ? '–' : `${s.sw > 0 ? '+' : ''}${s.sw}`, s.num > 1 ? 'aim -1' : undefined, 0, s.sw !== null && (s.sw <= -3 || s.sw >= 1)),
				el('td', 'muted', u.runs ? `usual from ${u.runs}` : '')
			);
			t.append(tr);
		}
		box.append(t);
		box.append(el('div', 'muted small', 'Grey numbers = your usual (median of the other landed attempts shown). Angle = median yawRatio in the strafe (1 = optimal). Switch = key switch in ticks from the mouse reversal; -1 is one tick before.'));
		box.append(
			el(
				'div',
				'muted small',
				!m
					? 'Mouse: type your mouse DPI in at the top to see each strafe in centimetres of mouse movement.'
					: `Mouse = how far you moved the mouse in the strafe, next to the optimal turn over the same ticks, at sens ${m.sens} and ${m.dpi} DPI${m.recorded ? '' : ' (the game\'s current sens: this attempt was recorded before sens was saved with it)'}. Ticks with +left/+right held are left out.`
			)
		);
	}
	if (f.mistakes.length > 1) {
		const ml = el('div', 'more');
		ml.append(el('b', '', 'All checks that fired: '));
		ml.append(f.mistakes.map((m) => `${m.name} ${m.lost.toFixed(1)} u/s`).join(' · '));
		box.append(ml);
	}
	drawFocus();
}

let focusGeom = null;
const FOCUS_LANES = [
	{ id: 'speed', title: 'Speed', unit: 'u/s', h: 120 },
	{ id: 'turn', title: 'Turn speed', unit: '°/tick', h: 120 },
	{ id: 'keys', title: 'Keys', unit: 'need / held', h: 44 },
	{ id: 'vsmed', title: 'Lost vs usual', unit: 'up = worse', h: 90 }
];

function drawFocus() {
	const boxEl = $('focus-box');
	const w = boxEl.clientWidth;
	const total = FOCUS_LANES.reduce((t, l) => t + l.h + LANE_GAP, 0) + AXIS_H;
	const g = size($('focus-cv'), w, total);
	const f = focused();
	focusGeom = null;
	if (!f) return;
	const others = shown.own.filter((e) => e.complete && e !== f);
	const b = best(others);
	const maxX = Math.max(f.ticks, ...others.map((e) => e.ticks), 1);
	const X = (x) => GUTTER + (x / maxX) * (w - GUTTER - 12);
	const medSpeed = others.length >= 2 ? medianCurve(others, 'speed', maxX) : null;
	const medLost = others.length >= 2 ? medianCurve(others, 'lost', maxX) : null;
	const vsmed = f.xs.map((x, i) => (medLost && Number.isFinite(medLost.ys[x]) ? f.lost[i] - medLost.ys[x] : NaN));
	const rng = (vals, pad, sym) => {
		const vs = vals.filter(Number.isFinite);
		if (!vs.length) return [0, 1];
		if (sym) {
			const m = Math.max(...vs.map(Math.abs), 1) * 1.08;
			return [-m, m];
		}
		const lo = Math.min(...vs);
		const hi = Math.max(...vs);
		const p = (hi - lo) * pad || 1;
		return [lo - p, hi + p];
	};
	const ranges = {
		speed: rng([...f.speed, ...(medSpeed ? medSpeed.ys : []), ...(b ? b.speed : [])], 0.05),
		turn: rng([...f.turn, ...f.opt.map((o) => o * 1.15)], 0, true),
		vsmed: rng([...vsmed, 0], 0.1, true)
	};
	const lanes = [];
	let top = 0;
	for (const l of FOCUS_LANES) {
		const t = top;
		const [lo, hi] = ranges[l.id] || [0, 1];
		lanes.push({ ...l, top: t, lo, hi, Y: (v) => t + 4 + (1 - (v - lo) / (hi - lo)) * (l.h - 8) });
		top += l.h + LANE_GAP;
	}
	focusGeom = { X, lanes, maxX, f, vsmed, medSpeed, b };
	g.font = '12px system-ui';
	const plotW = w - GUTTER - 12;
	const allBot = top - LANE_GAP;
	for (const l of lanes) {
		g.fillStyle = '#232733';
		g.fillRect(GUTTER, l.top, plotW, l.h);
		g.fillStyle = '#ff5c5c22';
		for (const m of f.mistakes) g.fillRect(X(m.x0) - 1, l.top, Math.max(X(m.x1) - X(m.x0), 0) + 2, l.h);
		g.strokeStyle = '#4a5468';
		g.lineWidth = 1;
		g.strokeRect(GUTTER + 0.5, l.top + 0.5, plotW - 1, l.h - 1);
		g.fillStyle = C.text;
		g.textAlign = 'left';
		g.fillText(l.title, 6, l.top + 16);
		g.fillStyle = C.muted;
		g.fillText(l.unit, 6, l.top + 31);
		g.save();
		g.beginPath();
		g.rect(GUTTER, l.top, plotW, l.h);
		g.clip();
		if (l.id !== 'keys') {
			g.textAlign = 'right';
			const step = niceStep(l.hi - l.lo, l.h, 26);
			for (let v = Math.ceil(l.lo / step) * step; v <= l.hi; v += step) {
				g.strokeStyle = v === 0 ? '#5a6478' : C.grid;
				g.beginPath();
				g.moveTo(GUTTER, l.Y(v));
				g.lineTo(w - 12, l.Y(v));
				g.stroke();
			}
		}
		if (l.id === 'speed') {
			if (b) polyline(g, b.xs, b.speed, X, l.Y, C.best, 1.6);
			if (medSpeed) polyline(g, medSpeed.xs, medSpeed.ys, X, l.Y, C.med, 1.5, [5, 4]);
			polyline(g, f.xs, f.speed, X, l.Y, C.last, 2.4);
		} else if (l.id === 'turn') {
			// optimal turn for this attempt's speed, both directions, with the 85-115 % band
			g.fillStyle = '#7bd88f22';
			for (let i = 0; i < f.xs.length; i++) {
				const o = f.opt[i];
				if (!Number.isFinite(o) || !f.want[i]) continue;
				const sgn = f.want[i];
				const y1 = l.Y(sgn * o * 0.85);
				const y2 = l.Y(sgn * o * 1.15);
				g.fillRect(X(f.xs[i] - 0.5), Math.min(y1, y2), X(1) - X(0) + 0.5, Math.abs(y2 - y1));
			}
			// one line per side, so a strafe change is a gap, not a slope from +opt to -opt
			for (const side of [1, -1]) polyline(g, f.xs, f.opt.map((o, i) => (f.want[i] === side ? side * o : NaN)), X, l.Y, '#7bd88f', 1);
			polyline(g, f.xs, f.turn, X, l.Y, '#c792ea', 2.2);
		} else if (l.id === 'keys') {
			const rowH = (l.h - 12) / 2;
			const cw = X(1) - X(0);
			const colr = { 1: '#4fd1c5', '-1': '#ffb454' };
			for (let i = 0; i < f.xs.length; i++) {
				const x = X(f.xs[i] - 0.5);
				if (f.want[i]) {
					g.fillStyle = colr[f.want[i]];
					g.fillRect(x, l.top + 4, cw + 0.5, rowH);
				}
				if (f.keys[i]) {
					g.fillStyle = f.want[i] && f.keys[i] !== f.want[i] && !f.btn[i] ? C.bad : colr[f.keys[i]];
					g.fillRect(x, l.top + 8 + rowH, cw + 0.5, rowH);
				} else if (f.want[i] && !f.btn[i]) {
					g.fillStyle = '#ff5c5c66';
					g.fillRect(x, l.top + 8 + rowH, cw + 0.5, rowH);
				}
			}
		} else if (l.id === 'vsmed') {
			polyline(g, f.xs, vsmed, X, l.Y, C.bad, 2);
		}
		g.restore();
		if (l.id !== 'keys') {
			g.fillStyle = C.muted;
			g.textAlign = 'right';
			const step = niceStep(l.hi - l.lo, l.h, 26);
			for (let v = Math.ceil(l.lo / step) * step; v <= l.hi; v += step) if (l.Y(v) > l.top + 8) g.fillText(`${+v.toFixed(1)}`, GUTTER - 6, l.Y(v) + 4);
		}
	}
	// strafe boundaries with labels on top of the speed lane
	g.textAlign = 'left';
	for (const s of f.strafes) {
		g.strokeStyle = '#ffffff40';
		g.setLineDash([3, 3]);
		g.beginPath();
		g.moveTo(X(s.x0 - 0.5), 0);
		g.lineTo(X(s.x0 - 0.5), allBot);
		g.stroke();
		g.setLineDash([]);
		g.fillStyle = C.text;
		g.fillText(`S${s.num} ${s.dir > 0 ? 'L' : 'R'}`, X(s.x0) + 3, 14);
	}
	g.fillStyle = C.muted;
	g.textAlign = 'center';
	const step = niceStep(maxX, plotW, 50);
	for (let x = 0; x <= maxX; x += step) g.fillText(`${x}`, X(x), top + 14);
	g.textAlign = 'left';
	g.fillText('ticks', 6, top + 14);
}

function focusRead(ev) {
	if (!focusGeom) return '';
	const { X, maxX, f, vsmed, medSpeed, b } = focusGeom;
	const r = $('focus-cv').getBoundingClientRect();
	const mx = ev.clientX - r.left;
	if (mx < GUTTER) return '';
	const x = Math.round(((mx - GUTTER) / (r.width - GUTTER - 12)) * maxX);
	const i = f.xs.indexOf(x);
	if (i < 0) return `tick ${x}`;
	const parts = [`tick ${x}`, `speed ${f.speed[i].toFixed(1)}`];
	if (medSpeed && Number.isFinite(medSpeed.ys[x])) parts.push(`usual ${medSpeed.ys[x].toFixed(1)}`);
	if (b) {
		const k = b.xs.indexOf(x);
		if (k >= 0) parts.push(`best ${b.speed[k].toFixed(1)}`);
	}
	parts.push(`turn ${Number.isFinite(f.turn[i]) ? f.turn[i].toFixed(2) : '–'}°`);
	if (Number.isFinite(f.opt[i])) parts.push(`optimal ${f.opt[i].toFixed(2)}°`);
	parts.push(`need ${KEY_NAME[f.want[i]] || '–'} held ${KEY_NAME[f.keys[i]] || 'none'}${f.btn[i] ? ' +left/right' : ''}`);
	if (Number.isFinite(vsmed[i])) parts.push(`lost vs usual ${vsmed[i] >= 0 ? '+' : ''}${vsmed[i].toFixed(1)}`);
	const m = f.mistakes.find((mm) => x >= mm.x0 && x <= mm.x1);
	if (m) parts.push(`⚠ ${m.name}`);
	return parts.join(' · ');
}

// ---------- events ----------

$('focus-cv').addEventListener('mousemove', (ev) => ($('focus-read').textContent = focusRead(ev)));
$('focus-cv').addEventListener('mouseleave', () => ($('focus-read').textContent = ''));
$('focus-latest').onclick = () => setFocus(null);
$('focus-open').onclick = () => {
	const f = focused();
	if (f) openMain(f);
};

$('trend').addEventListener('mousemove', (ev) => {
	const e = trendAt(ev);
	$('trend').style.cursor = e ? 'pointer' : 'default';
	setHover(e ? e.k : null);
});
$('trend').addEventListener('mouseleave', () => setHover(null));
$('trend').addEventListener('click', (ev) => {
	const e = trendAt(ev);
	if (e && !isOther(e.h)) setFocus(e.k);
});
$('stack').addEventListener('mousemove', (ev) => {
	const got = stackAt(ev);
	$('stack').style.cursor = got ? 'pointer' : 'crosshair';
	$('stack-read').textContent = got ? `${label(got.e)} · tick ${got.x} · ${got.l.title} ${got.v.toFixed(2)} ${got.l.unit}` : '';
	setHover(got ? got.e.k : null);
});
$('stack').addEventListener('mouseleave', () => {
	$('stack-read').textContent = '';
	setHover(null);
});
$('stack').addEventListener('click', (ev) => {
	const got = stackAt(ev);
	if (got) {
		if (isOther(got.e.h)) openMain(got.e);
		else setFocus(got.e.k);
	}
});
$('map').onchange = () => {
	followLatest = false;
	fillTags();
	render();
};
$('tag').onchange = () => {
	localStorage.setItem(TAG_KEY, $('tag').value);
	render();
};
$('scope').onchange = render;
new ResizeObserver(() => {
	drawFocus();
	drawTrend();
	drawStack();
}).observe($('drill-main'));

function live() {
	const src = new EventSource('/api/events');
	const dot = $('live');
	src.onopen = () => dot.classList.remove('off');
	src.onerror = () => dot.classList.add('off'); // EventSource reconnects by itself
	src.addEventListener('attempt', async (ev) => {
		const { dir, id } = JSON.parse(ev.data);
		fresh.add(`${dir}/${id}`);
		focusKey = null; // practice loop: a new attempt takes the focus
		// Older entries keep the weak-takeoff verdict from when they were loaded; one more attempt in
		// the baseline median barely moves it, and refetching every attempt would slow the update.
		await loadList();
		render();
	});
}

// cm per 360° at the newest own attempt's sens, to check against Momentum's own mouse settings page
function showCm360() {
	const h = list.find((a) => !isOther(a));
	const m = mouseFor(h, mouseNow, dpi);
	$('cm360').textContent = m ? `${(360 * m.cmPerDeg).toFixed(1)} cm/360° at sens ${m.sens}` : '';
}

$('dpi').onchange = () => {
	dpi = Number.parseFloat($('dpi').value);
	saveDpi(dpi);
	if (!(dpi > 0)) dpi = null;
	showCm360();
	showFocus();
};

Promise.all([
	loadList(),
	fetch('/api/mouse')
		.then((r) => r.json())
		.then((v) => (mouseNow = v))
		.catch(() => {})
]).then(() => {
	dpi = loadDpi() ?? dpiFromHeads(list);
	if (dpi) $('dpi').value = dpi;
	showCm360();
	render();
	live();
});
