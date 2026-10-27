'use strict';
// Strafe Review: attempt parsing and jump finding, shared by the page (app.js), the checks
// (checks.js) and the node harness (viewer/check_mistakes.js). No DOM here.

const BIT = { JUMP: 1 << 1, FORWARD: 1 << 3, LEFT: 1 << 7, RIGHT: 1 << 8, MOVELEFT: 1 << 9, MOVERIGHT: 1 << 10 };
const AIR_ADD = 30; // u/s the air move adds square to velocity per tick (measured on own runs: 30.00)

function wrap180(a) {
	return ((((a + 180) % 360) + 360) % 360) - 180;
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
	if (d.derived) {
		for (let i = 0; i < n; i++) {
			const v = i > 0 ? d.speed[i - 1] : NaN;
			const ok = i > 0 && d.gap[i] === 0 && !d.ground[i];
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
	const jumps = takeoffs.map((s, k) => {
		const stop = k + 1 < takeoffs.length ? takeoffs[k + 1] : d.n;
		let e = s + 1;
		while (e < stop && !d.ground[e]) e++;
		let g = 0;
		let id = 0;
		for (let j = s; j < e; j++) {
			g += d.gain[j];
			id += d.ideal[j];
		}
		return { s, e, x0: d.x[s], x1: d.x[e - 1], pct: id > 0 ? (100 * g) / id : NaN, takeoff: d.speed[s], land: d.speed[e - 1] };
	});
	// Jump 1 takes off in the start zone: the one in the air when the timer starts, else the next one
	const p = Math.min(preRows || 0, d.n - 1);
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

if (typeof module !== 'undefined') module.exports = { BIT, AIR_ADD, wrap180, parse, findJumps, runGaps };
