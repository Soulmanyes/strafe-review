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
	loss: '#ff5c5c80',
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
	hover: '#ffffffcc'
};
const GUTTER = 128; // lane titles and y labels
const RIGHT_PAD = 12;
const LANE_GAP = 8;
const AXIS_H = 30;
const LANES = [
	{ id: 'jumps', h: 38, title: 'Jumps', sub: 'gain % of ideal' },
	{ id: 'yaw', h: 140, title: 'Yaw speed', sub: '°/tick vs optimal' },
	{ id: 'ratio', h: 110, title: 'Angle', sub: 'yawRatio, 1 = optimal' },
	{ id: 'gain', h: 140, title: 'Gain', sub: 'u/s per tick vs ideal' },
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
const SETTINGS_KEY = 'strafe-review-checks';


function labelText(h) {
	return h.label === 'replay' ? `Replay: ${h.player || 'unknown player'}` : 'Own run';
}

function labelChip(h) {
	const el = document.createElement('span');
	el.className = `chip ${h.label === 'replay' ? 'replay' : 'own'}`;
	el.textContent = labelText(h);
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

// ---------- list ----------

async function loadList() {
	list = await (await fetch('/api/attempts')).json();
	const box = $('list');
	box.replaceChildren();
	if (!list.length) box.textContent = 'No attempts saved yet.';
	const maps = [...new Set(list.map((a) => a.dir))];
	for (const m of maps) {
		const title = document.createElement('div');
		title.className = 'map-name';
		title.textContent = m;
		box.append(title);
		for (const a of list.filter((x) => x.dir === m)) {
			const b = document.createElement('button');
			b.className = 'att';
			b.dataset.key = `${a.dir}/${a.id}`;
			const r1 = document.createElement('div');
			r1.className = 'row1';
			r1.append(labelChip(a), reasonChip(a));
			const r2 = document.createElement('div');
			r2.className = 'row2';
			const t = a.runTime ? `${a.runTime.toFixed(2)} s` : '';
			r2.textContent = [when(a.started), t, `${a.gaps} missed`].filter(Boolean).join(' · ');
			b.append(r1, r2);
			b.onclick = () => open(a.dir, a.id);
			box.append(b);
		}
	}
	markSelected();
	findMistakes(); // the takeoff baseline comes from the list
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
	cur = { head: a, d, jumps, j1, tps: Math.round(1 / a.interval), endIdx: a.postRows ? d.n - 1 - a.postRows : d.n - 1 };
	location.hash = `${dir}/${id}`;
	hoverIdx = -1;
	selMistake = null;
	showHead();
	markSelected();
	findMistakes();
	whole();
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
		.filter((a) => a.dir === h.dir && a.interval === h.interval && a.label !== 'replay' && a.id !== h.id && Number.isFinite(a.j1Takeoff))
		.map((a) => a.j1Takeoff);
	return vs.length ? { takeoffMedian: median(vs), takeoffRuns: vs.length } : null;
}

function findMistakes() {
	if (!cur) return;
	cur.mistakes = runChecks(cur.d, cur.jumps, cur.endIdx, loadSettings(), takeoffBaseline(cur.head));
	if (selMistake && !cur.mistakes.some((m) => m.check === selMistake.check && m.i0 === selMistake.i0)) selMistake = null;
	showMistakes();
}

function showMistakes() {
	const box = $('mistakes-list');
	box.replaceChildren();
	const ms = cur ? cur.mistakes : [];
	const total = ms.reduce((t, m) => t + m.lost, 0);
	$('mistakes-sum').textContent = cur ? `${ms.length} found · ranked by speed lost (sum of ideal - gain over the ticks involved), ${total.toFixed(0)} u/s in all` : '';
	if (cur && !ms.length) box.textContent = 'No mistakes found with the current settings.';
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
		`${h.gaps} missed ticks`,
		`style ${h.style}`,
		`${cur.jumps.filter((j) => j.num > 0).length} jumps`,
		when(h.started)
	].join(' · ');
	el.append(name, labelChip(h), reasonChip(h), facts);
	if (cur.d.derived) {
		const note = document.createElement('span');
		note.className = 'chip replay';
		note.textContent = 'Gain and angle rebuilt from speed (no tick stats in this recording)';
		el.append(note);
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
		if (!Number.isFinite(v) || !ok(i)) {
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
			const label = `${j.num ? j.num : 'pre'} · ${Number.isFinite(j.pct) ? j.pct.toFixed(0) : '?'}%`;
			if (g.measureText(label).width < X1 - X0 - 8) {
				g.fillStyle = COL.text;
				g.fillText(label, X0 + 6, l.y + l.h / 2 + 4);
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
		const optMax = quantile(d, i0, i1, (i) => (ok(i) ? d.opt[i] : NaN), 0.98);
		const hi = Number.isFinite(optMax) ? optMax * 2.2 : Math.max(1, quantile(d, i0, i1, (i) => Math.abs(d.yawd[i]), 0.98));
		const Y = yMap(l, 0, hi);
		// optimal band, 85-115 %
		g.fillStyle = COL.band;
		for (let i = i0; i <= i1; i++) {
			const o = d.opt[i];
			if (!Number.isFinite(o)) continue;
			g.fillRect(px(d.x[i] - 0.5), Y(o * 1.15), Math.max(px(d.x[i] + 0.5) - px(d.x[i] - 0.5), 1), Y(o * 0.85) - Y(o * 1.15));
		}
		line(g, d, i0, i1, (i) => Math.abs(d.yawd[i]), Y, COL.raw, 1);
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
		const isAir = air(d);
		const ok = strafingRows(d);
		const hi = Math.max(0.1, quantile(d, i0, i1, (i) => (ok(i) ? Math.max(d.ideal[i], d.gain[i]) : NaN), 0.98) * 1.1);
		const lo = Math.max(-hi, Math.min(0, minOf(d, i0, i1, (i) => (ok(i) ? d.gain[i] : NaN))));
		const Y = yMap(l, lo, hi);
		// lost gain, shaded between gain and ideal
		g.fillStyle = COL.loss;
		for (let i = i0; i <= i1; i++) {
			if (!isAir(i) || !(d.gain[i] < d.ideal[i])) continue;
			const X0 = px(d.x[i] - 0.5);
			g.fillRect(X0, Y(d.ideal[i]), Math.max(px(d.x[i] + 0.5) - X0, 1), Y(d.gain[i]) - Y(d.ideal[i]));
		}
		line(g, d, i0, i1, (i) => d.ideal[i], Y, COL.opt, 1.5, isAir);
		line(g, d, i0, i1, (i) => d.gain[i], Y, COL.line, 2, isAir);
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
	},

	speed(g, l, d, i0, i1) {
		const hi = Math.max(50, quantile(d, i0, i1, (i) => d.speed[i], 0.995) * 1.08);
		const Y = yMap(l, 0, hi);
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
		['gain', `${f(d.gain[i], 3)} / ${f(d.ideal[i], 3)}`],
		['yaw', `${f(d.yawd[i], 2)}° (avg ${f(d.yaws[i], 2)}, opt ${f(d.opt[i], 2)})`],
		['ratio', f(d.ratio[i], 3)],
		['keys', keys || 'none'],
		['ideal', d.ideal_key[i] > 0 ? 'A' : d.ideal_key[i] < 0 ? 'D' : '–']
	];
	if (d.gap[i] > 0) fields.push(['missed before', String(d.gap[i])]);
	$('readout').innerHTML = fields.map(([k, v]) => `<span><span class="k">${k}</span> ${v}</span>`).join('');
}

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
		e.preventDefault();
		const rect = over.getBoundingClientRect();
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
$('checks-btn').onclick = () => {
	const sec = $('settings');
	sec.hidden = !sec.hidden;
	if (!sec.hidden) {
		showSettings();
		sec.scrollIntoView({ block: 'nearest' });
	}
};
$('reset-checks').onclick = () => {
	localStorage.removeItem(SETTINGS_KEY);
	showSettings();
	findMistakes();
	draw();
};
new ResizeObserver(() => draw()).observe($('plot'));

loadList().then(() => {
	const [dir, id] = location.hash.slice(1).split('/');
	if (dir && id) open(dir, id);
	else if (list.length) open(list[0].dir, list[0].id);
});
