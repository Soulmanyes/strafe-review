'use strict';
// Strafe Review: attempt parsing and jump finding, shared by the page (app.js), the checks
// (checks.js) and the node harness (viewer/check_mistakes.js). No DOM here.

const BIT = { JUMP: 1 << 1, FORWARD: 1 << 3, BACK: 1 << 4, LEFT: 1 << 7, RIGHT: 1 << 8, MOVELEFT: 1 << 9, MOVERIGHT: 1 << 10 };
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

// Momentum's TrackType: 0 main, 1 stage, 2 bonus. Old files without a track are main.
const TRACK_NAMES = ['', 's', 'b'];

// The course a recording ran: the map folder for the main track, "<map>: b2" for bonus 2, "<map>: s3"
// for stage 3.
// Attempts only compare on the same course (and tickrate).
function course(h) {
	const t = h.track || {};
	return t.type ? `${h.dir}: ${TRACK_NAMES[t.type] || `t${t.type}-`}${t.number ?? ''}` : h.dir;
}

// Ticks per second as Momentum names it: 0.015 s is "66 tick", not 67
function tickRate(interval) {
	return Math.floor(1 / interval + 0.05);
}

function whoseRun(h) {
	if (h.label === 'replay') return `Replay: ${h.player || 'unknown player'}`;
	if (h.label === 'spectate') return `Spectated: ${h.player || 'unknown player'}`;
	return 'Own run';
}

function parse(a) {
	const ix = {};
	a.cols.forEach((c, i) => (ix[c] = i));
	let lines = a.rows ? a.rows.split(';') : [];
	// Rows before the last teleport ahead of the timer start aren't this run (a replay opens with the end of
	// the player's previous run, then a teleport into the start zone): drop them, and move preRows with them.
	// Same teleport rule as findJumps(). a.rows is rewritten too, so parsing the same object again is a no-op.
	{
		const p = Math.min(a.preRows || 0, lines.length - 1);
		const sp = (ln) => {
			const v = ln.split(',');
			return [+v[ix.tick], Math.hypot(+v[ix.vx], +v[ix.vy])];
		};
		let tp = -1;
		let [t0, s0] = p > 0 ? sp(lines[0]) : [0, 0];
		for (let i = 1; i <= p; i++) {
			const [t1, s1] = sp(lines[i]);
			if (t1 - t0 === 1 && ((s0 > 100 && s1 < 1) || (s0 < 1 && s1 > 100))) tp = i;
			[t0, s0] = [t1, s1];
		}
		if (tp > 0) {
			lines = lines.slice(tp);
			a.rows = lines.join(';');
			a.preRows = p - tp;
			a.droppedRows = (a.droppedRows || 0) + tp;
		}
	}
	const n = lines.length;
	const want = ['tick', 'gain', 'ideal', 'ratio', 'right', 'vx', 'vy', 'vz', 'yaw', 'buttons', 'wx', 'wy'];
	const d = { n, interval: a.interval || 0.01 };
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
	// CS:S gain: a recording's wish velocity is used only when it has any in the air (it might read 0 for other
	// players), and keys only when they line up with the moves (d.ownKeys below)
	d.hasWish = false;
	for (let i = 0; i < n && !d.hasWish; i++) if (!d.ground[i] && Math.hypot(d.wx[i], d.wy[i]) > 0.1) d.hasWish = true;
	// A replay's view angles trail its velocity and keys by about 60 ms (6 ticks at 100 tick, 4 at 66; own run vs
	// its own replay: velocity and keys equal tick for tick, yaw equal only 6 rows later). Read them that much
	// later, so turn, keys and moves line up as they did in the run. The fit is per recording; a fragment
	// too short or rough to fit (err of 1 u/s or more) gets the 60 ms default.
	d.angleShift = 0;
	if (a.label === 'replay' && !d.coarse) {
		const fit = angleFit(d);
		d.angleShift = fit.err < SSJ_FIT_MAX ? fit.lag : Math.round(REPLAY_ANGLE_LAG / d.interval);
		if (d.angleShift) {
			const yaw = new Float64Array(n);
			for (let i = 0, j = 0; i < n; i++) {
				while (j < n - 1 && d.tick[j] < d.tick[i] + d.angleShift) j++;
				yaw[i] = d.yaw[j];
			}
			d.yaw = yaw;
		}
		delete d.angleFit;
	}
	// keys line up with the moves in own runs and replays, not in coarse spectated rows
	d.ownKeys = a.label !== 'spectate' && !d.coarse;
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

// CS:S-style jump gain, the way the SSJ plugin (Nairdaa/shavit-ssj) works it out. Every tick (see ssjJump()
// for which) is scored from p = previous velocity · wishdir:
// (30 - |p|) / 30 when p < 30, else 0 (no key held: 0; negative when moving against wishdir).
// Jump gain = average score * 100. SSJ's wall-touch flip is left out (no wall data here).
// The plugin reads the move's own angles; the recorded yaw is a per-frame sample up to ~1.3° off the
// real wishdir, and at 1000 u/s 1° moves p by 17. So air rows use the velocity instead: the air move adds
// (30 - p) along wishdir, so the change in horizontal velocity m = |v - v_prev| gives p = 30 - m exactly
// (score m / 30 up to 30, (60 - m) / 30 above). Changes over 60 u/s count only when they line up with the
// wishdir from yaw + keys within 5° (turning far ahead of the velocity); else teleport, booster or wall, skipped.
// A takeoff row is a ground move, so it uses the yaw and keys, read `lag` rows later (angleFit()): a
// recording's angles can trail its velocity (parse() already moves a replay's angles back). Rows after missed
// ticks are skipped.
const SSJ_LAG_MAX = 10;
const REPLAY_ANGLE_LAG = 0.06; // seconds a replay's view angles trail its velocity and keys (see parse())

function wishDir(d, yi, ki) {
	const b = d.buttons[ki];
	const f = (b & BIT.FORWARD ? 1 : 0) - (b & BIT.BACK ? 1 : 0);
	const sd = (b & BIT.MOVERIGHT ? 1 : 0) - (b & BIT.MOVELEFT ? 1 : 0);
	if (!f && !sd) return null;
	const y = (d.yaw[yi] * Math.PI) / 180;
	const wx = Math.cos(y) * f + Math.sin(y) * sd;
	const wy = Math.sin(y) * f - Math.cos(y) * sd;
	const l = Math.hypot(wx, wy);
	return [wx / l, wy / l];
}

// { lag, err }: yaw row offset (0..SSJ_LAG_MAX) with the smallest mean speed error (u/s) over air rows
function angleFit(d) {
	if (d.angleFit) return d.angleFit;
	let best = { lag: 0, err: NaN };
	for (let lag = 0; lag <= SSJ_LAG_MAX; lag++) {
		let err = 0;
		let n = 0;
		for (let i = 1; i + lag < d.n; i++) {
			if (d.ground[i] || d.ground[i - 1] || d.gap[i] > 0 || d.speed[i - 1] < 200) continue;
			let ok = true;
			for (let k = i + 1; k <= i + lag; k++) if (d.gap[k] > 0) ok = false;
			if (!ok) continue;
			const w = wishDir(d, i + lag, i);
			let px = d.vx[i - 1];
			let py = d.vy[i - 1];
			if (w) {
				const add = AIR_ADD - (px * w[0] + py * w[1]);
				if (add > 0) {
					px += add * w[0];
					py += add * w[1];
				}
			}
			err += Math.abs(Math.hypot(px, py) - d.speed[i]);
			n++;
		}
		if (n && !(err / n >= best.err)) best = { lag, err: err / n };
	}
	d.angleFit = best;
	return best;
}

// SSJ score of one row and whether it counts: { c, ok }. Air rows from the velocity change; the takeoff row
// (a ground move) from yaw + keys.
const SSJ_MAX_DV = 2 * AIR_ADD;
const SSJ_ALIGN_COS = Math.cos((5 * Math.PI) / 180); // a big velocity change within 5° of wishdir is a real air move
const SSJ_FIT_MAX = 1; // u/s: a worse angle fit leaves takeoff rows out (the angles don't match the moves)
const SSJ_NEXT_MAX = 10; // ground ticks before the next takeoff still counted on the same SSJ line

function ssjRow(d, i, fit, takeoff) {
	if (i < 1 || i >= d.n || d.gap[i] > 0) return { c: 0, ok: false };
	const score = (w) => {
		if (!w) return { c: 1, ok: true }; // no key: SSJ counts it as a synced, perfect tick (measured on a CS:S server)
		const p = d.vx[i - 1] * w[0] + d.vy[i - 1] * w[1];
		return { c: p < AIR_ADD ? (AIR_ADD - Math.abs(p)) / AIR_ADD : 0, ok: true };
	};
	// recordings since 2026-10-28 carry the game's own wish velocity: its direction is exact for every row
	// (checked against the velocity change: p within 0.02 u/s), so no angles are needed
	const wl = Math.hypot(d.wx[i], d.wy[i]);
	const recorded = d.hasWish && Number.isFinite(wl);
	const wish = recorded && wl > 0.1 ? [d.wx[i] / wl, d.wy[i] / wl] : null;
	const lagged = recorded ? wish : fit.err <= SSJ_FIT_MAX && i + fit.lag < d.n ? wishDir(d, i + fit.lag, i) : null;
	if (takeoff) {
		if (!recorded && (!(fit.err <= SSJ_FIT_MAX) || i + fit.lag >= d.n)) return { c: 0, ok: false };
		if (!lagged && !recorded && !d.ownKeys) return { c: 0, ok: true }; // someone else's keys: no-key not trusted
		return score(lagged);
	}
	const dx = d.vx[i] - d.vx[i - 1];
	const dy = d.vy[i] - d.vy[i - 1];
	const m = Math.hypot(dx, dy);
	// velocity wiped to a standstill: a reset or teleport (an air move never lands on zero), skipped
	if (m > 5 && Math.hypot(d.vx[i], d.vy[i]) < 0.5) return { c: 0, ok: false };
	// over 60 u/s: an air move only when it lines up with the keys' wishdir (turning far ahead of the
	// velocity, scored negative by SSJ); otherwise a teleport, booster or wall, skipped
	if (m > SSJ_MAX_DV && (!lagged || (dx * lagged[0] + dy * lagged[1]) / m < SSJ_ALIGN_COS)) return { c: 0, ok: false };
	if (recorded) return score(wish);
	const b = d.buttons[i];
	const keyed = (b & BIT.FORWARD ? 1 : 0) - (b & BIT.BACK ? 1 : 0) || (b & BIT.MOVERIGHT ? 1 : 0) - (b & BIT.MOVELEFT ? 1 : 0);
	if (!keyed && d.ownKeys) return score(null);
	return { c: (m <= AIR_ADD ? m : SSJ_MAX_DV - m) / AIR_ADD, ok: true };
}

// SSJ sum and tick count for one jump the way its chat line adds them up: SSJ prints on the next jump,
// so a line holds the air rows after takeoff, the landing row (its move starts in the air) and the next
// jump's takeoff row (when it comes within SSJ_NEXT_MAX rows). The jump's own takeoff row is on the line before.
function ssjJump(d, j, next, fit) {
	let sum = 0;
	let n = 0;
	const add = (r) => {
		if (!r.ok) return;
		sum += r.c;
		n++;
	};
	for (let i = j.s + 1; i <= Math.min(j.e, d.n - 1); i++) add(ssjRow(d, i, fit, false));
	// in CS:S the landing tick is the next jump's tick (no ground row between), already counted above
	if (next && next.s > j.e && next.s - j.e <= SSJ_NEXT_MAX) add(ssjRow(d, next.s, fit, true));
	return { sum, n };
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
	const fit = d.coarse ? null : angleFit(d);
	jumps.forEach((j, k) => {
		const r = fit ? ssjJump(d, j, jumps[k + 1], fit) : { sum: 0, n: 0 };
		j.ssj = r.n ? (100 * r.sum) / r.n : NaN;
		j.ssjSum = r.sum;
		j.ssjN = r.n;
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
const PATH_MAX_GAP = 5;

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
	// over more than a few missed ticks the straight guess is too rough to draw (one replay lost 115 ticks):
	// the position still moves on, but no line is drawn across
	const hole = (i) => (d.gap[i] > PATH_MAX_GAP ? 1 : 0);
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
		brk[i] = hole(i);
	}
	// backwards from the timer start: row i - 1 = row i minus row i's move
	for (let i = p; i > 0; i--) {
		if (tp(i)) break;
		x[i - 1] = x[i] - d.vx[i] * step(i);
		y[i - 1] = y[i] - d.vy[i] * step(i);
		brk[i] = hole(i);
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

// The same path turned to another angle (another recording's turn), so overlaid paths share one frame:
// every path is built from world velocities with the timer start at (0, 0), but each snaps its own turn,
// and a drill or an attempt off the map axis snaps to a different one
function turnPath(path, turn) {
	const by = turn - path.turn;
	if (!by) return path;
	const c = Math.cos(by);
	const sn = Math.sin(by);
	const x = new Float64Array(path.x.length);
	const y = new Float64Array(path.y.length);
	for (let i = 0; i < x.length; i++) {
		x[i] = path.x[i] * c - path.y[i] * sn;
		y[i] = path.x[i] * sn + path.y[i] * c;
	}
	return { ...path, x, y, turn };
}

// Gain % of ideal over 5 ticks around each air row, for the path colour (NaN on the ground). A coarse
// recording (spectated live, see parse()) gets its jump's % on every air row instead.
function pathPct(d, jumps) {
	const pct = new Float64Array(d.n).fill(NaN);
	if (d.coarse) {
		for (const j of jumps) for (let i = j.s; i < j.e; i++) if (!d.ground[i]) pct[i] = j.pct;
		return pct;
	}
	for (let i = 0; i < d.n; i++) {
		if (d.ground[i]) continue;
		let g = 0;
		let id = 0;
		for (let j = Math.max(0, i - 2); j <= Math.min(d.n - 1, i + 2); j++) {
			if (d.ground[j] || !Number.isFinite(d.gain[j]) || !Number.isFinite(d.ideal[j])) continue;
			g += d.gain[j];
			id += d.ideal[j];
		}
		if (id > 0) pct[i] = (100 * g) / id;
	}
	return pct;
}

// A recording's path with its colour, cut at the run end: a paused replay's extra rows keep their last
// velocity, so the path would run on past the end. d must be the recording's own rows, not an aligned
// copy (alignGhost() rewrites gap, which buildPath() reads for step lengths, teleports and holes).
function recordingPath(head, d, jumps, endIdx) {
	const path = { ...buildPath(d, head.interval, head.preRows), pct: pathPct(d, jumps) };
	for (let i = endIdx + 1; i <= d.n - 1 - (head.postRows || 0); i++) path.x[i] = path.y[i] = NaN;
	return path;
}

// A comparison's gain colour: its own colour (hex #rrggbb) from dark at 60 % and under to bright at 95 % and
// over, so it never clashes with the red-green scale of the recording it is compared with. No % (ground,
// no stats): the plain colour, half see-through.
function gainShade(p, hex) {
	if (!Number.isFinite(p)) return `${hex}80`;
	const t = Math.max(0, Math.min(1, (p - 60) / 35));
	const ch = (k) => parseInt(hex.slice(k, k + 2), 16);
	// dark = 45 % of the colour (still visible on the dark card), bright = the colour mixed 35 % toward white
	const mix = (c) => Math.round(c * 0.45 + (c + (255 - c) * 0.35 - c * 0.45) * t);
	return `rgb(${mix(ch(1))},${mix(ch(3))},${mix(ch(5))})`;
}

// Keeps a hover readout at the tallest it has been for this width and key (for example how many recordings
// are shown), so the graph under it doesn't jump as the values change length.
const heldHeights = new WeakMap();
function holdHeight(box, key = '') {
	const id = `${box.clientWidth}|${key}`;
	let held = heldHeights.get(box);
	if (!held || held.id !== id) held = { id, h: 0 };
	box.style.minHeight = '';
	held.h = Math.max(held.h, box.offsetHeight);
	heldHeights.set(box, held);
	box.style.minHeight = `${held.h}px`;
}

if (typeof module !== 'undefined') module.exports = { BIT, AIR_ADD, TRACK_NAMES, course, tickRate, SSJ_LAG_MAX, REPLAY_ANGLE_LAG, SSJ_MAX_DV, wishDir, angleFit, ssjRow, ssjJump, SPECTATE_MIN_AIR, isOther, whoseRun, wrap180, parse, findJumps, runGaps, runEnd, alignGhost, ghostNearest, buildPath, pathDistance, turnPath, pathPct, recordingPath, gainShade };
