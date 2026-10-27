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
let followLatest = true; // the map picker follows the newest attempt until it's changed by hand
let shown = { own: [], replays: [] }; // entries on the page now
let fresh = new Set(); // keys that arrived live, flashed once
let hoverKey = null;
let renderToken = 0;

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
		.filter((a) => a.dir === h.dir && a.interval === h.interval && a.label !== 'replay' && a.id !== h.id && Number.isFinite(a.j1Takeoff))
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
		const mistakes = runChecks(d, jumps, endIdx, loadSettings(), takeoffBaseline(h), h.label === 'replay').filter((m) => m.jump === 1);
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
			lostTotal: sum,
			mistakes
		};
	}
	cache.set(k, e);
	return e;
}

function maps() {
	const out = new Map();
	for (const h of list) if (!out.has(mapKey(h))) out.set(mapKey(h), h); // list is newest first
	return out;
}

// Own attempts on the picked map, either the latest session or all, oldest first
function pick() {
	const mk = $('map').value;
	const own = list.filter((h) => mapKey(h) === mk && h.label !== 'replay').sort((a, b) => a.started - b.started);
	const replays = list.filter((h) => mapKey(h) === mk && h.label === 'replay');
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
}

async function render() {
	const token = ++renderToken;
	const { own, replays } = pick();
	const ownE = (await Promise.all(own.map(entry))).filter(Boolean);
	// a replay is only a reference when its jump 1 landed in the recording
	const repE = (await Promise.all(replays.map(entry))).filter((e) => e && e.complete);
	if (token !== renderToken) return; // a newer render started meanwhile
	shown = { own: ownE, replays: repE };
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
		stat('Best landing', `${b.land.toFixed(1)} u/s`, `gain ${b.pct.toFixed(0)} % · ${when(b.h.started)} · open`, () => openMain(b)),
		stat('Median landing', `${median(lands).toFixed(1)} u/s`, `takeoff median ${median(done.map((e) => e.takeoff)).toFixed(1)} u/s`),
		stat('Consistency', `±${(iqr(lands) / 2).toFixed(1)} u/s`, `landing IQR ${iqr(lands).toFixed(1)} u/s (middle half of attempts)`),
		stat('Median gain', `${median(pcts).toFixed(1)} %`, `IQR ${iqr(pcts).toFixed(1)} % points`)
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
		n.textContent = `Reference: Replay: ${r.h.player || 'unknown player'}, landing ${r.land.toFixed(1)} u/s, gain ${r.pct.toFixed(0)} % (not counted)`;
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
	return e.h.label === 'replay' ? `Replay: ${e.h.player || 'unknown player'}` : `${when(e.h.started)}`;
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
	polyline(g, e.xs, e.speed, X, sY, e.h.label === 'replay' ? C.rep : C.text, 1.6);
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
		card.className = `card${e === b ? ' best' : ''}${fresh.has(e.k) ? ' fresh' : ''}${e.complete ? '' : ' cut'}`;
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
			? `${e.takeoff.toFixed(0)} → ${e.land.toFixed(0)} u/s (${e.land >= e.takeoff ? '+' : ''}${(e.land - e.takeoff).toFixed(0)}) · gain ${e.pct.toFixed(0)} % · ${e.ticks} ticks`
			: `takeoff ${e.takeoff.toFixed(0)} u/s · run ended ${e.ticks} ticks in`;
		const m = document.createElement('div');
		m.className = 'worst';
		const w = e.mistakes[0];
		m.textContent = w ? `${w.name}: ${w.text} (${w.lost.toFixed(1)} u/s)` : 'No jump-1 mistakes found';
		if (!w) m.classList.add('none');
		card.append(top, cv, nums, m);
		mini(cv, e, maxX, ranges);
		card.onclick = () => openMain(e);
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

// ---------- events ----------

$('trend').addEventListener('mousemove', (ev) => {
	const e = trendAt(ev);
	$('trend').style.cursor = e ? 'pointer' : 'default';
	setHover(e ? e.k : null);
});
$('trend').addEventListener('mouseleave', () => setHover(null));
$('trend').addEventListener('click', (ev) => {
	const e = trendAt(ev);
	if (e) openMain(e);
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
	if (got) openMain(got.e);
});
$('map').onchange = () => {
	followLatest = false;
	render();
};
$('scope').onchange = render;
new ResizeObserver(() => {
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
		// Older entries keep the weak-takeoff verdict from when they were loaded; one more attempt in
		// the baseline median barely moves it, and refetching every attempt would slow the update.
		await loadList();
		render();
	});
}

loadList().then(() => {
	render();
	live();
});
