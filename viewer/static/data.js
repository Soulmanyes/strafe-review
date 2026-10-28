'use strict';
// Strafe Review: attempt parsing and jump finding, shared by the page (app.js), the checks
// (checks.js) and the node harness (viewer/check_mistakes.js). No DOM here.

const BIT = { JUMP: 1 << 1, FORWARD: 1 << 3, LEFT: 1 << 7, RIGHT: 1 << 8, MOVELEFT: 1 << 9, MOVERIGHT: 1 << 10 };
const AIR_ADD = 30; // u/s the air move adds square to velocity per tick (measured on own runs: 30.00)

function wrap180(a) {
	return ((((a + 180) % 360) + 360) % 360) - 180;
}

// Fewest air rows before an 'own' attempt with no tick stats is taken for a spectated one
const SPECTATE_MIN_AIR = 20;

// Someone else's recording: a replay ('replay') or a live player spectated ('spectate')
function isOther(h) {
	return h.label !== 'own';
}

function whoseRun(h) {
	if (h.label === 'replay') return `Replay: ${h.player || 'unknown player'}`;
	if (h.label === 'spectate') return `Spectated: ${h.player || 'unknown player'}`;
	return 'Own run';
}

function parse(a) {
	const ix = {};
	a.cols.forEach((c, i) => (ix[c] = i));
	const lines = a.rows ? a.rows.split(';') : [];
	const n = lines.length;
	const want = ['tick', 'gain', 'ideal', 'ratio', 'right', 'vx', 'vy', 'vz', 'yaw', 'buttons'];
	const d = { n };
	for (const w of want) d[w] = new Float64Array(n);
	lines.forEach((ln, i) => {
		const v = ln.split(',');
		for (const w of want) d[w][i] = ix[w] === undefined ? NaN : +v[ix[w]];
	});
	const p = Math.min(a.preRows || 0, n - 1);
	const start = d.tick[p];
	for (const k of ['x', 'speed', 'gap', 'yawd', 'yaws', 'opt', 'ideal_key']) d[k] = new Float64Array(n);
	d.ground = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		d.x[i] = d.tick[i] - start;
		d.speed[i] = Math.hypot(d.vx[i], d.vy[i]);
		d.gap[i] = i > 0 ? d.tick[i] - d.tick[i - 1] - 1 : 0;
	}
	// Ground: vz is exactly 0 there (the move column reads 0 on every row, so it can't be used).
	// A vz of 0 between rising and falling is an apex, not ground.
	for (let i = 0; i < n; i++) {
		if (d.vz[i] !== 0) continue;
		const prev = i > 0 ? d.vz[i - 1] : 0;
		const next = i < n - 1 ? d.vz[i + 1] : 0;
		d.ground[i] = prev > 0 && next < 0 ? 0 : 1;
	}
	// Replays carry no tick stats (GetLastTickStats() reads 0 while spectating). Own runs show
	// gain = change in horizontal speed and ideal = sqrt(v^2 + 30^2) - v exactly, so both are rebuilt from speed.
	d.derived = !d.ideal.some((v, i) => v !== 0 && !d.ground[i]);
	// Recorders before the 'spectate' label saved a spectated live player as 'own' (same rule as the server's head())
	if (d.derived && a.label === 'own' && d.ground.reduce((c, g) => c + (g ? 0 : 1), 0) >= SPECTATE_MIN_AIR) a.label = 'spectate';
	// A spectated live player's velocity only changes on every 5th tick or so (network updates), so the
	// rebuilt gain is 0 on most ticks and the whole change on one: only per-jump sums mean anything.
	let airRows = 0;
	let changed = 0;
	for (let i = 1; i < n; i++) {
		if (d.ground[i] || d.gap[i] > 0) continue;
		airRows++;
		if (d.vx[i] !== d.vx[i - 1] || d.vy[i] !== d.vy[i - 1]) changed++;
	}
	d.coarse = d.derived && airRows >= SPECTATE_MIN_AIR && changed < airRows / 2;
	if (d.derived) {
		for (let i = 0; i < n; i++) {
			const v = i > 0 ? d.speed[i - 1] : NaN;
			// a rise of more than one tick's air add is a teleport, not strafing (replays open with a teleport-in);
			// in coarse rows a drop of over 100 u/s in one row is a wall hit (the finish wall), left out of the jump's %
			const ok = i > 0 && d.gap[i] === 0 && !d.ground[i] && d.speed[i] - v <= AIR_ADD && !(d.coarse && d.speed[i] - v < -100);
			d.gain[i] = ok ? d.speed[i] - v : NaN;
			d.ideal[i] = ok ? Math.sqrt(v * v + AIR_ADD * AIR_ADD) - v : NaN;
		}
	}
	for (let i = 0; i < n; i++) {
		d.yawd[i] = i > 0 && d.gap[i] === 0 ? wrap180(d.yaw[i] - d.yaw[i - 1]) : NaN;
		// Optimal turn per tick: wishdir square to velocity adds `a` sideways, so (v+ideal)^2 = v^2 + a^2
		// and the velocity turns atan(a / v). Matches the game's yawRatio (median 0.78 vs 0.79 on a test run).
		const v = i > 0 ? d.speed[i - 1] : NaN;
		const g = d.ideal[i];
		d.opt[i] =
			!d.ground[i] && d.gap[i] === 0 && v > 30 && g > 0
				? (Math.atan(Math.sqrt(Math.max((v + g) ** 2 - v * v, 0)) / v) * 180) / Math.PI
				: NaN;
	}
	// Per-tick yaw is jumpy (frames and ticks don't line up), so a 5-tick average is drawn on top
	for (let i = 0; i < n; i++) {
		let sum = 0;
		let cnt = 0;
		for (let j = i - 2; j <= i + 2; j++) {
			if (j < 0 || j >= n || Math.abs(d.x[j] - d.x[i]) > 2 || !Number.isFinite(d.yawd[j])) continue;
			sum += d.yawd[j];
			cnt++;
		}
		d.yaws[i] = cnt ? sum / cnt : NaN;
		// Ideal key follows the turn: yaw going up is a left turn (A), down is right (D)
		d.ideal_key[i] = !d.ground[i] && Math.abs(d.yaws[i]) > 0.3 ? Math.sign(d.yaws[i]) : 0;
	}
	if (d.derived) for (let i = 0; i < n; i++) d.ratio[i] = d.opt[i] > 0 ? Math.abs(d.yaws[i]) / d.opt[i] : NaN;
	return d;
}

function findJumps(d, preRows) {
	const takeoffs = [];
	for (let i = 1; i < d.n; i++) if (d.vz[i] > 100 && d.vz[i - 1] <= 0.5) takeoffs.push(i);
	let jumps = takeoffs.map((s, k) => {
		const stop = k + 1 < takeoffs.length ? takeoffs[k + 1] : d.n;
		let e = s + 1;
		while (e < stop && !d.ground[e]) e++;
		let g = 0;
		let id = 0;
		for (let j = s; j < e; j++) {
			// a replay row after missed ticks has no gain (rebuilt from speed), so it is left out of both sums
			if (!Number.isFinite(d.gain[j]) || !Number.isFinite(d.ideal[j])) continue;
			g += d.gain[j];
			id += d.ideal[j];
		}
		return { s, e, x0: d.x[s], x1: d.x[e - 1], pct: id > 0 ? (100 * g) / id : NaN, takeoff: d.speed[s], land: d.speed[e - 1] };
	});
	// Jump 1 takes off in the start zone: the one in the air when the timer starts, else the next one
	const p = Math.min(preRows || 0, d.n - 1);
	// Hops that end before the last teleport ahead of the timer start aren't this run: a replay opens with
	// the end of the player's previous run, then a teleport into the start zone. A teleport is the speed
	// going from 100+ to standstill, or from standstill to 100+, in one tick.
	let tp = -1;
	for (let i = 1; i <= p; i++) {
		if (d.gap[i] > 0) continue;
		const a = d.speed[i - 1];
		const b = d.speed[i];
		if ((a > 100 && b < 1) || (a < 1 && b > 100)) tp = i;
	}
	if (tp > 0) jumps = jumps.filter((j) => j.e > tp);
	let j1 = jumps.findIndex((j) => j.s <= p && j.e > p);
	if (j1 < 0) j1 = jumps.findIndex((j) => j.s >= p);
	jumps.forEach((j, k) => (j.num = j1 < 0 || k < j1 ? 0 : k - j1 + 1));
	return { jumps, j1 };
}

// Missed ticks inside the run: from the timer start to the run end (runTime, else the last row before
// the post-end tail). A replay pauses at its end, which reads as one long gap and isn't run data.
function runGaps(a, d) {
	const p = Math.min(a.preRows || 0, d.n - 1);
	const last = a.postRows ? d.n - 1 - a.postRows : d.n - 1;
	const span = a.runTime ? Math.round(a.runTime / a.interval) : Infinity;
	let g = 0;
	for (let i = p + 1; i <= last && d.x[i] <= span; i++) g += d.gap[i];
	return g;
}

// Lines a comparison recording (the ghost) up with the open one. Returns its x per row (NaN for rows
// left out) and a gap array that also breaks the line where the shift changes.
//  - 'timer': both start at the timer start, no shift.
//  - 'jump': jumps are matched by number. Jump k's air keeps its own spacing, shifted so its takeoff sits
//    on the open attempt's jump-k takeoff. The ground after it is stretched or squeezed to end at the next
//    matched takeoff; air or ground that would run past it is left out. Rows before jump 1 take the
//    jump-1 shift, rows after the last matched jump keep the last shift.
// Falls back to 'timer' (mode in the result says so) when no jump number is in both.
function alignGhost(cur, cmp, mode) {
	const d = cmp.d;
	const x = new Float64Array(d.n);
	const gap = new Float64Array(d.n);
	const byNum = new Map(cur.jumps.filter((j) => j.num > 0).map((j) => [j.num, j]));
	const pairs = cmp.jumps.filter((j) => j.num > 0 && byNum.has(j.num)).map((j) => ({ c: j, o: byNum.get(j.num) }));
	if (mode !== 'jump' || !pairs.length) {
		x.set(d.x);
		gap.set(d.gap);
		return { x, gap, mode: 'timer', matched: 0 };
	}
	let k = 0; // pair whose takeoff is at or before row i (pair 0 also covers rows before it)
	let prevSeg = -1;
	for (let i = 0; i < d.n; i++) {
		while (k + 1 < pairs.length && pairs[k + 1].c.s <= i) k++;
		const { c, o } = pairs[k];
		const off = o.x0 - c.x0;
		const next = k + 1 < pairs.length && i >= c.s ? pairs[k + 1] : null;
		let v = d.x[i] + off;
		let seg = 2 * k;
		if (next) {
			const end = next.o.x0; // the next matched takeoff of the open attempt
			if (i >= c.e) {
				// ground after the landing: [landing, next takeoff) of the ghost onto [landing + shift, end)
				seg = 2 * k + 1;
				const a0 = d.x[c.e] ?? d.x[i];
				const a1 = next.c.x0;
				const A = a0 + off;
				v = A >= end || a1 <= a0 ? NaN : A + ((d.x[i] - a0) * (end - A)) / (a1 - a0);
			}
			if (!(v < end)) v = NaN;
		}
		x[i] = v;
		gap[i] = d.gap[i] > 0 || seg !== prevSeg || (i > 0 && !Number.isFinite(x[i - 1])) ? Math.max(d.gap[i], 1) : 0;
		if (i === 0) gap[i] = 0;
		prevSeg = seg;
	}
	return { x, gap, mode: 'jump', matched: pairs.length };
}

// Ghost row nearest to x, among rows with a finite x (those only ever go up), or -1 beyond maxDist
function ghostNearest(gx, order, xv, maxDist) {
	if (!order.length) return -1;
	let lo = 0;
	let hi = order.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (gx[order[mid]] < xv) lo = mid;
		else hi = mid;
	}
	const i = Math.abs(gx[order[lo]] - xv) <= Math.abs(gx[order[hi]] - xv) ? order[lo] : order[hi];
	return Math.abs(gx[i] - xv) <= maxDist ? i : -1;
}

// Last row of the run: before the post-end tail, and no later than runTime after the timer start. A replay
// pauses at its end and keeps sending rows, which aren't run data.
function runEnd(a, d) {
	let last = a.postRows ? d.n - 1 - a.postRows : d.n - 1;
	const span = a.runTime ? Math.round(a.runTime / a.interval) : Infinity;
	while (last > 0 && d.x[last] > span + 1) last--;
	return last;
}

// Top-down path: no position API, so the position is built up from velocity times the tick interval
// (a row after missed ticks counts for all of them). The timer start is (0, 0). A teleport (speed from
// 100+ to standstill or back in one tick) breaks the line: after it the path starts again at (0, 0), and
// rows before the last teleport ahead of the timer start (a replay's previous run) get no position.
// The path is turned so the way out of the start zone points up (+y). The first few hundred units bend with
// the prestrafe and jump 1, so the direction is taken from the timer start to the point 1000 units along
// the path (or as far as the attempt gets), then snapped to the nearest map axis when within 25 degrees:
// maps are built on the grid, so every attempt on a map gets the same turn. Under 32 units in all, the
// velocity at the timer start is used.
// Returns { x, y, brk, turn }: x and y in units after the turn (NaN = no position), brk[i] = 1 when row
// i isn't joined to row i - 1, turn = the angle added to world directions (radians, e.g. for the yaw).
function buildPath(d, interval, preRows) {
	const n = d.n;
	const x = new Float64Array(n).fill(NaN);
	const y = new Float64Array(n).fill(NaN);
	const brk = new Uint8Array(n);
	if (!n) return { x, y, brk };
	const p = Math.min(preRows || 0, n - 1);
	const tp = (i) => {
		if (d.gap[i] > 0) return false;
		const a = d.speed[i - 1];
		const b = d.speed[i];
		return (a > 100 && b < 1) || (a < 1 && b > 100);
	};
	const step = (i) => interval * (d.gap[i] + 1);
	x[p] = 0;
	y[p] = 0;
	brk[p] = 1;
	for (let i = p + 1; i < n; i++) {
		if (tp(i)) {
			x[i] = 0;
			y[i] = 0;
			brk[i] = 1;
			continue;
		}
		x[i] = x[i - 1] + d.vx[i] * step(i);
		y[i] = y[i - 1] + d.vy[i] * step(i);
	}
	// backwards from the timer start: row i - 1 = row i minus row i's move
	for (let i = p; i > 0; i--) {
		if (tp(i)) break;
		x[i - 1] = x[i] - d.vx[i] * step(i);
		y[i - 1] = y[i] - d.vy[i] * step(i);
		brk[i] = 0;
		brk[i - 1] = 1;
	}
	let far = p;
	let along = 0;
	for (let i = p + 1; i < n && !brk[i] && along < 1000; i++) {
		along += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
		far = i;
	}
	const [hx, hy] = Math.hypot(x[far], y[far]) >= 32 ? [x[far], y[far]] : [d.vx[p], d.vy[p]];
	let head = Math.atan2(hy, hx);
	const axis = Math.round(head / (Math.PI / 2)) * (Math.PI / 2);
	if (Math.abs(head - axis) <= (25 * Math.PI) / 180) head = axis;
	const turn = hx || hy ? Math.PI / 2 - head : 0;
	const c = Math.cos(turn);
	const sn = Math.sin(turn);
	for (let i = 0; i < n; i++) {
		const wx = x[i];
		x[i] = wx * c - y[i] * sn;
		y[i] = wx * sn + y[i] * c;
	}
	return { x, y, brk, turn };
}

// Horizontal distance along the path from row i0 to row i1, in units; teleports and rows with no
// position add nothing
function pathDistance(path, i0, i1) {
	let s = 0;
	for (let i = Math.max(i0 + 1, 1); i <= i1; i++) {
		if (path.brk[i] || !Number.isFinite(path.x[i]) || !Number.isFinite(path.x[i - 1])) continue;
		s += Math.hypot(path.x[i] - path.x[i - 1], path.y[i] - path.y[i - 1]);
	}
	return s;
}

if (typeof module !== 'undefined') module.exports = { BIT, AIR_ADD, SPECTATE_MIN_AIR, isOther, whoseRun, wrap180, parse, findJumps, runGaps, runEnd, alignGhost, ghostNearest, buildPath, pathDistance };
