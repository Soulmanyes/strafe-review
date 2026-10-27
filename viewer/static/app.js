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
let ghost = null; // { key, head, d, jumps, gd, order, mode, matched, how }: the comparison drawn dashed pink
const ghostCache = new Map(); // "<map>/<id>" -> { head, d, jumps }
const CMP_KEY = 'strafe-review-compare'; // { "<map>|<interval>": choice }
const ALIGN_KEY = 'strafe-review-align';
const SETTINGS_KEY = 'strafe-review-checks';
const DRILLS_KEY = 'strafe-review-show-drills';
// A drill: an own attempt that didn't finish and landed this many jumps or fewer (jump 1 or SSJ practice)
const DRILL_MAX_JUMPS = 7;


function isDrill(h) {
	return h.label !== 'replay' && h.reason !== 'finish' && Number.isFinite(h.landed) && h.landed <= DRILL_MAX_JUMPS;
}

// A replay recording with no landed jump, or a shorter copy of a replay file recorded again (a replay
// that starts over after its end is recorded until it is stopped). Never listed unless it is open.
function isFragment(h) {
	if (h.label !== 'replay') return false;
	if (h.landed === 0) return true;
	const f = h.replayFile;
	return !!f && list.some((o) => o !== h && o.label === 'replay' && o.replayFile === f && o.rowCount > h.rowCount);
}

function labelText(h) {
	return h.label === 'replay' ? `Replay: ${h.player || 'unknown player'}` : 'Own run';
}

function labelChip(h) {
	const el = document.createElement('span');
	const drill = isDrill(h);
	el.className = `chip ${h.label === 'replay' ? 'replay' : drill ? 'drill' : 'own'}`;
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

// ---------- list ----------

async function loadList() {
	list = await (await fetch('/api/attempts')).json();
	const box = $('list');
	box.replaceChildren();
	if (!list.length) box.textContent = 'No attempts saved yet.';
	const showDrills = $('show-drills').checked;
	$('drill-count').textContent = list.filter(isDrill).length;
	// the open attempt stays listed even when it is a hidden drill
	const openKey = cur ? `${cur.head.dir}/${cur.head.id}` : location.hash.slice(1).split('/').slice(0, 2).join('/');
	const visible = list.filter((a) => `${a.dir}/${a.id}` === openKey || ((showDrills || !isDrill(a)) && !isFragment(a)));
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
			b.onclick = () => open(a.dir, a.id);
			box.append(b);
		}
	}
	markSelected();
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
	fillCompare();
	await setGhostSafe();
	showHead();
	markSelected();
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
	const own = cands.filter((h) => h.label !== 'replay');
	const reps = cands.filter((h) => h.label === 'replay');
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
		g = { head: a, d, jumps: findJumps(d, a.preRows).jumps };
		ghostCache.set(key, g);
	}
	const al = alignGhost(cur, g, $('align').value);
	const gd = Object.assign({}, g.d, { x: al.x, gap: al.gap });
	const order = [];
	for (let i = 0; i < gd.n; i++) if (Number.isFinite(gd.x[i])) order.push(i);
	const v = $('cmp-sel').value;
	const how = v.startsWith('p:') ? presets(candidates()).find((p) => p.id === v).name : 'picked';
	ghost = { key, head: g.head, d: g.d, jumps: g.jumps, gd, order, mode: al.mode, matched: al.matched, how };
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
		.filter((a) => a.dir === h.dir && a.interval === h.interval && a.label !== 'replay' && a.id !== h.id && a.j1Takeoff >= MIN_TAKEOFF)
		.map((a) => a.j1Takeoff);
	return vs.length ? { takeoffMedian: median(vs), takeoffRuns: vs.length } : null;
}

function findMistakes() {
	if (!cur) return;
	cur.mistakes = runChecks(cur.d, cur.jumps, cur.endIdx, loadSettings(), takeoffBaseline(cur.head), cur.head.label === 'replay');
	if (selMistake && !cur.mistakes.some((m) => m.check === selMistake.check && m.i0 === selMistake.i0)) selMistake = null;
	showMistakes();
}

function showMistakes() {
	const box = $('mistakes-list');
	box.replaceChildren();
	const ms = cur ? cur.mistakes : [];
	const total = ms.reduce((t, m) => t + m.lost, 0);
	const skipped = cur && cur.head.label === 'replay' ? " · key timing checks are skipped for replays (their keys run ahead of the turn)" : '';
	$('mistakes-sum').textContent = cur ? `${ms.length} found · ranked by speed lost (sum of ideal - gain over the ticks involved), ${total.toFixed(0)} u/s in all${skipped}` : '';
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
	if (cur.d.derived) note('replay', 'Gain and angle rebuilt from speed (no tick stats in this recording)');
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
		if (gh.label === 'replay') note('ghost', 'Ghost keys not drawn: replay keys run ahead of the angles');
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
		// scales come from the whole attempt, so panning or zooming never rescales a lane
		const optMax = quantile(d, 0, d.n - 1, (i) => (ok(i) ? d.opt[i] : NaN), 0.98);
		const hi = Number.isFinite(optMax) ? optMax * 2.2 : Math.max(1, quantile(d, 0, d.n - 1, (i) => Math.abs(d.yawd[i]), 0.98));
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
		const isAir = air(d);
		const ok = strafingRows(d);
		const hi = Math.max(0.1, quantile(d, 0, d.n - 1, (i) => (ok(i) ? Math.max(d.ideal[i], d.gain[i]) : NaN), 0.98) * 1.1);
		// 2nd percentile, not the minimum: over a whole run one wall hit would squash the lane
		const lo = Math.max(-hi, Math.min(0, quantile(d, 0, d.n - 1, (i) => (ok(i) ? d.gain[i] : NaN), 0.02)));
		const Y = yMap(l, lo, hi);
		// lost gain, shaded between gain and ideal
		g.fillStyle = COL.loss;
		for (let i = i0; i <= i1; i++) {
			if (!isAir(i) || !(d.gain[i] < d.ideal[i])) continue;
			const X0 = px(d.x[i] - 0.5);
			g.fillRect(X0, Y(d.ideal[i]), Math.max(px(d.x[i] + 0.5) - X0, 1), Y(d.gain[i]) - Y(d.ideal[i]));
		}
		line(g, d, i0, i1, (i) => d.ideal[i], Y, COL.opt, 1.5, isAir);
		ghostLine(g, (i) => ghost.gd.gain[i], Y, air);
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
		// the ghost's A and D: a thin pink strip along the bottom of those rows (not for replays, whose
		// keys run 3-7 ticks ahead of the angles)
		if (ghost && ghost.head.label !== 'replay') {
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
$('align').value = localStorage.getItem(ALIGN_KEY) === 'timer' ? 'timer' : 'jump';
$('cmp-sel').onchange = compareChanged;
$('to-compare').onclick = () => {
	if (!cur) return;
	const ids = [cur.head.id, ...(ghost ? [ghost.head.id] : [])];
	location.href = `/compare#${cur.head.dir}/${ids.join(',')}`;
};
$('align').onchange = compareChanged;
$('show-drills').checked = localStorage.getItem(DRILLS_KEY) === '1';
$('show-drills').onchange = () => {
	localStorage.setItem(DRILLS_KEY, $('show-drills').checked ? '1' : '0');
	loadList();
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

// A new attempt saved by the collector shows up in the list at once (the open one stays open)
new EventSource('/api/events').addEventListener('attempt', loadList);

loadList().then(async () => {
	// #<map>/<id>/j1 (from the drill page) opens the attempt zoomed to jump 1
	const [dir, id, what] = location.hash.slice(1).split('/');
	if (dir && id) {
		await open(dir, id);
		if (what === 'j1' && cur && cur.j1 >= 0) zoomTo(cur.jumps[cur.j1]);
	} else {
		const first = list.find((a) => ($('show-drills').checked || !isDrill(a)) && !isFragment(a)) || list[0];
		if (first) open(first.dir, first.id);
	}
});
