'use strict';
// Strafe Review: mistake checks. Pure functions over parse()/findJumps() output (data.js), so the
// node harness (viewer/check_mistakes.js) runs the same code as the page.
//
// A strafe is a run of one turn direction (ideal_key) inside a jump; ticks with no clear turn
// (|avg yaw| <= 0.3°) don't break it. Only jumps 1+ and rows up to the run end are checked.
// Ticks with +left/+right held turn at a fixed cl_yawspeed, so the checks that judge how the mouse
// turned (angle, turn speed, keys while turning) skip them. Timing checks (early reversal, late first
// strafe, switch) still count them: the owner holds +left into jump 1 on purpose.

// Defaults come from the owner's 14 own attempts on bhop_ambience (PLAN.md "Mistake checks").
const CHECKS = [
	{ id: 'early', name: 'Early reversal', on: true, help: 'Jump 1 only: the strafe you take off with is reversed sooner than this (counted from where that turn began).', params: { minTicks: { label: 'shortest first strafe (ticks at 100 tick)', v: 18 } } },
	{ id: 'lateFirst', name: 'Late first strafe', on: true, help: 'Ticks from takeoff to the first correct key while turning.', params: { maxTicks: { label: 'most ticks allowed (at 100 tick)', v: 3 } } },
	{ id: 'takeoff', name: 'Weak takeoff', on: true, help: 'Jump-1 takeoff speed below the median of your own attempts on this map.', params: { below: { label: 'u/s below your median', v: 8 }, minRuns: { label: 'attempts needed for a median', v: 5 } } },
	{ id: 'wide', name: 'Too wide / too fast', on: true, help: "Median angle (yawRatio) over a strafe's middle, its first and last ticks skipped.", params: { ratio: { label: 'median yawRatio above', v: 1.2 }, skip: { label: 'ticks skipped at each end', v: 3 } } },
	{ id: 'narrow', name: 'Too narrow / too slow', on: true, help: "Median angle (yawRatio) over a strafe's middle, its first and last ticks skipped.", params: { ratio: { label: 'median yawRatio below', v: 0.4 }, skip: { label: 'ticks skipped at each end', v: 3 } } },
	{ id: 'uneven', name: 'Uneven turn speed', on: true, help: "Spread of the 5-tick average turn speed over a strafe's middle: (90th - 10th percentile) / median.", params: { spread: { label: 'spread above', v: 0.9 }, skip: { label: 'ticks skipped at each end', v: 3 } } },
	{ id: 'balance', name: 'Left/right imbalance', on: true, help: 'Gain % of left strafes vs right strafes over the whole run.', params: { points: { label: 'difference above (% points)', v: 12 }, minStrafes: { label: 'strafes needed per side', v: 4 } } },
	{ id: 'wrongKey', name: 'Wrong key', on: true, help: 'Turning one way while only the other strafe key is held, away from a switch.', params: { minTicks: { label: 'ticks in a row (at 100 tick)', v: 2 } } },
	{ id: 'noKey', name: 'No key while turning', on: true, help: 'Turning with neither A nor D held, away from a switch.', params: { minTicks: { label: 'ticks in a row (at 100 tick)', v: 3 } } },
	{ id: 'switch', name: 'Early/late switch', on: true, help: 'Key switch offset from the turn reversal. Target -1 (one tick before).', params: { early: { label: 'early from (ticks before reversal)', v: 4 }, late: { label: 'late from (ticks after reversal)', v: 2 } } },
	{ id: 'wAir', name: 'W held in air', on: false, help: 'Off by default: many jump binds release W on their own.', params: { minTicks: { label: 'air ticks with W (at 100 tick)', v: 5 } } }
];
// Timing params are tick counts at 100 tick. On other tickrates they cover the same time, rounded up
// (66 tick: early 18 -> 12, wrongKey 2 -> 2). Switch offsets stay in ticks: the target is "one tick
// before the reversal" at any tickrate.
const TIMED = { early: ['minTicks'], lateFirst: ['maxTicks'], wrongKey: ['minTicks'], noKey: ['minTicks'], wAir: ['minTicks'] };
const atRate = (ticks, interval) => Math.ceil((ticks * 0.01) / interval - 1e-6);

// Replays' keys run 3-7 ticks ahead of their view angles (one WR replay: every switch at -3 to -7,
// own runs centre on -1), so key timing in a replay says nothing about the player. Skipped there.
const REPLAY_SKIP = ['lateFirst', 'wrongKey', 'noKey', 'switch'];
const SWITCH_WINDOW = 8; // a key switch further than this from a reversal belongs to no reversal
// A jump-1 takeoff slower than this wasn't a real jump (a reset before jumping read 34 u/s, a replay
// fragment 0), so it is neither judged nor counted in the median
const MIN_TAKEOFF = 150;

function median(vs) {
	if (!vs.length) return NaN;
	const s = [...vs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(vs, q) {
	if (!vs.length) return NaN;
	const s = [...vs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// Held strafe key: +1 = A only, -1 = D only, 0 = none or both (same sign as ideal_key)
function keyDir(b) {
	const a = (b & BIT.MOVELEFT) !== 0;
	const dd = (b & BIT.MOVERIGHT) !== 0;
	return a && !dd ? 1 : dd && !a ? -1 : 0;
}

// Rows worth judging: in the air at 100+ u/s. Falling at near-zero speed has ideal gain near 30 u/s
// per tick, which would swamp every loss sum (same rule as the page's lane scales).
// A tick losing more than COLLISION u/s is a wall or ramp hit, not strafing, so it's left out too.
const COLLISION = 10;
const strafing = (d, i) => !d.ground[i] && d.speed[i] > 100 && !(d.gain[i] < -COLLISION);
const turnBtn = (d, i) => (d.buttons[i] & (BIT.LEFT | BIT.RIGHT)) !== 0;

// Rows a check may look at in jump j: its air time, cut at the run end
function jumpRange(j, endIdx) {
	return [j.s, Math.min(j.e, endIdx + 1)];
}

// Strafes of one jump: { dir, i0, i1, n, gap, btn } with i0..i1 the first and last tick turning `dir`
function strafesOf(d, j, endIdx) {
	const [s, e] = jumpRange(j, endIdx);
	const out = [];
	let cur = null;
	for (let i = s; i < e; i++) {
		const k = d.ideal_key[i];
		if (!k) continue;
		if (!cur || cur.dir !== k) {
			cur = { dir: k, i0: i, i1: i, gap: false, btn: 0 };
			out.push(cur);
		}
		cur.i1 = i;
	}
	for (const st of out) {
		st.n = d.tick[st.i1] - d.tick[st.i0] + 1;
		for (let i = st.i0; i <= st.i1; i++) {
			if (i > st.i0 && d.gap[i] > 0) st.gap = true;
			if (turnBtn(d, i)) st.btn++;
		}
	}
	return out;
}

// Key switches in one jump: ticks where the held key turns to the other side
function switchesOf(d, j, endIdx) {
	const [s, e] = jumpRange(j, endIdx);
	const out = [];
	let last = 0;
	for (let i = Math.max(s - SWITCH_WINDOW, 0); i < e; i++) {
		const k = keyDir(d.buttons[i]);
		if (!k) continue;
		if (last && k !== last) out.push({ i, dir: k });
		last = k;
	}
	return out;
}

// Speed lost over rows i0..i1: sum of ideal - gain where both are known
function lostOver(d, i0, i1) {
	let s = 0;
	for (let i = i0; i <= i1; i++) if (strafing(d, i) && Number.isFinite(d.gain[i]) && Number.isFinite(d.ideal[i])) s += d.ideal[i] - d.gain[i];
	return Math.max(s, 0);
}

// First row of the turn toward `dir` that is in progress at row s: steps back over that direction and
// over short stretches with no turn (a bhop's ground tick), stopping at the other direction or a gap
function turnStart(d, s, dir) {
	let from = s;
	let still = 0;
	for (let i = s - 1; i >= 0 && d.gap[i + 1] === 0; i--) {
		const k = d.ideal_key[i];
		if (k === dir) {
			from = i;
			still = 0;
		} else if (k || ++still > 3) break;
	}
	return from;
}

// Middle of a strafe for the angle checks: ends skipped, gaps and turn-button ticks left out
function interior(d, st, skip) {
	const out = [];
	for (let i = st.i0 + skip; i <= st.i1 - skip; i++) if (strafing(d, i) && !turnBtn(d, i) && d.gap[i] === 0) out.push(i);
	return out;
}

// Runs of rows passing `bad` (consecutive ticks, no gap), at least `min` long
function runs(d, from, to, bad, min) {
	const out = [];
	let r = null;
	for (let i = from; i < to; i++) {
		if (bad(i) && !(r && d.gap[i] > 0)) {
			if (!r) r = { i0: i, i1: i };
			r.i1 = i;
			continue;
		}
		if (r && r.i1 - r.i0 + 1 >= min) out.push(r);
		r = bad(i) ? { i0: i, i1: i } : null;
	}
	if (r && r.i1 - r.i0 + 1 >= min) out.push(r);
	return out;
}

const SIDE = { 1: 'left', '-1': 'right' };

// settings: { <checkId>: { on, <param>: value } }, filled from CHECKS defaults where missing.
// baseline: { takeoffMedian, takeoffRuns } of the other own attempts on this map and tickrate, or null.
// replay: true for someone's replay, which skips the REPLAY_SKIP checks.
// Returns mistakes [{ check, name, jump, i0, i1, lost, text }], biggest loss first.
function runChecks(d, jumps, endIdx, settings, baseline, replay = false) {
	const cfg = {};
	for (const c of CHECKS) {
		const s = (settings && settings[c.id]) || {};
		cfg[c.id] = { on: (s.on === undefined ? c.on : s.on) && !(replay && REPLAY_SKIP.includes(c.id)) };
		for (const [p, def] of Object.entries(c.params)) cfg[c.id][p] = s[p] === undefined ? def.v : s[p];
		for (const p of TIMED[c.id] || []) cfg[c.id][p] = atRate(cfg[c.id][p], d.interval || 0.01);
	}
	const name = Object.fromEntries(CHECKS.map((c) => [c.id, c.name]));
	const out = [];
	const add = (check, j, i0, i1, text, lost) =>
		out.push({ check, name: name[check], jump: j ? j.num : 0, i0, i1, lost: lost === undefined ? lostOver(d, i0, i1) : lost, text });
	const side = { 1: { g: 0, id: 0, n: 0 }, '-1': { g: 0, id: 0, n: 0 } };

	for (const j of jumps) {
		if (!j.num || j.s > endIdx) continue;
		const [s, e] = jumpRange(j, endIdx);
		const strafes = strafesOf(d, j, endIdx);
		const reversals = strafes.slice(1).map((st) => st.i0);
		const nearReversal = (i) => reversals.some((r) => Math.abs(d.tick[i] - d.tick[r]) <= SWITCH_WINDOW / 2);
		const tag = `Jump ${j.num}`;

		// Early reversal: the strafe in progress at takeoff, or the first one after it. It's counted from
		// where that turn began, which in a bhop is often before the landing. Jump 1 only: on later, faster
		// jumps top replays reverse after 10-17 ticks, so a short first strafe there is normal.
		const first = strafes[0];
		if (cfg.early.on && j.num === 1 && first && strafes.length > 1 && !first.gap) {
			const from = turnStart(d, s, first.dir);
			const len = d.tick[first.i1] - d.tick[from] + 1;
			if (len < cfg.early.minTicks) add('early', j, s, first.i1, `${tag}: first strafe ${len} ticks, then reversed (min ${cfg.early.minTicks})`);
		}

		// Late first strafe: takeoff to the first tick turning with the matching key
		if (cfg.lateFirst.on) {
			let at = -1;
			for (let i = s; i < e; i++) {
				if (d.ideal_key[i] && keyDir(d.buttons[i]) === d.ideal_key[i]) {
					at = i;
					break;
				}
			}
			const delay = at < 0 ? NaN : d.tick[at] - d.tick[s];
			if (delay > cfg.lateFirst.maxTicks) add('lateFirst', j, s, at - 1, `${tag}: first correct key ${delay} ticks after takeoff`);
		}

		for (const st of strafes) {
			const sname = `${tag}, ${SIDE[st.dir]} strafe`;
			// Angle checks use the game's yawRatio (rebuilt from yaw for replays)
			if (!st.gap && st.n >= 8) {
				const inW = interior(d, st, cfg.wide.skip).filter((i) => Number.isFinite(d.ratio[i]));
				const mW = median(inW.map((i) => d.ratio[i]));
				if (cfg.wide.on && inW.length >= 4 && mW > cfg.wide.ratio) add('wide', j, st.i0, st.i1, `${sname}: yawRatio ${mW.toFixed(2)} (over ${cfg.wide.ratio})`, lostOver(d, inW[0], inW[inW.length - 1]));
				const inN = interior(d, st, cfg.narrow.skip).filter((i) => Number.isFinite(d.ratio[i]));
				const mN = median(inN.map((i) => d.ratio[i]));
				const barely = mN < 0.05 ? 'barely turning, ' : '';
				if (cfg.narrow.on && inN.length >= 4 && mN < cfg.narrow.ratio) add('narrow', j, st.i0, st.i1, `${sname}: ${barely}yawRatio ${mN.toFixed(2)} (under ${cfg.narrow.ratio})`, lostOver(d, inN[0], inN[inN.length - 1]));
				const inU = interior(d, st, cfg.uneven.skip).map((i) => Math.abs(d.yaws[i])).filter(Number.isFinite);
				const mid = median(inU);
				const spread = mid > 0 ? (pct(inU, 0.9) - pct(inU, 0.1)) / mid : NaN;
				if (cfg.uneven.on && inU.length >= 6 && spread > cfg.uneven.spread) add('uneven', j, st.i0, st.i1, `${sname}: turn speed spread ${spread.toFixed(2)} (over ${cfg.uneven.spread})`);
			}
			if (!st.btn) {
				const sd = side[st.dir];
				for (let i = st.i0; i <= st.i1; i++) {
					if (!strafing(d, i) || !Number.isFinite(d.gain[i]) || !Number.isFinite(d.ideal[i])) continue;
					sd.g += d.gain[i];
					sd.id += d.ideal[i];
				}
				sd.n++;
			}
		}

		// Wrong key / no key: turning ticks away from a reversal (those belong to the switch check)
		const judged = (i) => d.ideal_key[i] && !turnBtn(d, i) && !nearReversal(i);
		if (cfg.wrongKey.on)
			for (const r of runs(d, s, e, (i) => judged(i) && keyDir(d.buttons[i]) === -d.ideal_key[i], cfg.wrongKey.minTicks))
				add('wrongKey', j, r.i0, r.i1, `${tag}: turning ${SIDE[d.ideal_key[r.i0]]} with only ${d.ideal_key[r.i0] > 0 ? 'D' : 'A'} held, ${r.i1 - r.i0 + 1} ticks`);
		if (cfg.noKey.on)
			for (const r of runs(d, s, e, (i) => judged(i) && !(d.buttons[i] & (BIT.MOVELEFT | BIT.MOVERIGHT)), cfg.noKey.minTicks))
				add('noKey', j, r.i0, r.i1, `${tag}: turning with no strafe key, ${r.i1 - r.i0 + 1} ticks`);

		// Switch timing: the key switch nearest each reversal, offset in ticks (target -1)
		if (cfg.switch.on) {
			const sw = switchesOf(d, j, endIdx);
			for (let k = 1; k < strafes.length; k++) {
				const st = strafes[k];
				if (st.gap || strafes[k - 1].gap) continue;
				const r = st.i0;
				let best = null;
				for (const w of sw) {
					if (w.dir !== st.dir) continue;
					const off = d.tick[w.i] - d.tick[r];
					if (Math.abs(off) <= SWITCH_WINDOW && (!best || Math.abs(off + 1) < Math.abs(best.off + 1))) best = { off, i: w.i };
				}
				if (!best) continue;
				const lo = Math.min(best.i, r);
				const hi = Math.max(best.i, r);
				if (best.off <= -cfg.switch.early) add('switch', j, lo, hi, `${tag}: switched to ${st.dir > 0 ? 'A' : 'D'} ${-best.off} ticks before the reversal (target 1)`);
				else if (best.off >= cfg.switch.late) add('switch', j, lo, hi, `${tag}: switched to ${st.dir > 0 ? 'A' : 'D'} ${best.off} ticks after the reversal (target 1 before)`);
			}
		}

		if (cfg.wAir.on) {
			let n = 0;
			for (let i = s; i < e; i++) if (d.buttons[i] & BIT.FORWARD) n++;
			if (n >= cfg.wAir.minTicks) add('wAir', j, s, e - 1, `${tag}: W held ${n} air ticks`);
		}
	}

	// Left/right imbalance: one entry per run
	const L = side[1];
	const R = side[-1];
	if (cfg.balance.on && L.n >= cfg.balance.minStrafes && R.n >= cfg.balance.minStrafes && L.id > 0 && R.id > 0) {
		const pl = (100 * L.g) / L.id;
		const pr = (100 * R.g) / R.id;
		if (Math.abs(pl - pr) > cfg.balance.points) {
			const worse = pl < pr ? L : R;
			const lost = worse.id * (Math.abs(pl - pr) / 100);
			const runStart = jumps.find((j) => j.num === 1);
			add('balance', null, runStart ? runStart.s : 0, endIdx, `Left strafes ${pl.toFixed(2)} %, right strafes ${pr.toFixed(2)} % of ideal gain (${L.n} left, ${R.n} right)`, lost);
		}
	}

	// Weak takeoff: jump 1 against the own-attempt median on this map and tickrate
	const j1 = jumps.find((j) => j.num === 1);
	if (cfg.takeoff.on && j1 && j1.takeoff >= MIN_TAKEOFF && baseline && baseline.takeoffRuns >= cfg.takeoff.minRuns) {
		const short = baseline.takeoffMedian - j1.takeoff;
		if (short > cfg.takeoff.below)
			add('takeoff', j1, j1.s, j1.s, `Jump 1: takeoff ${j1.takeoff.toFixed(0)} u/s, your median ${baseline.takeoffMedian.toFixed(0)} (${baseline.takeoffRuns} attempts)`, short);
	}

	out.sort((a, b) => b.lost - a.lost);
	return out;
}

if (typeof module !== 'undefined') module.exports = { CHECKS, TIMED, atRate, REPLAY_SKIP, MIN_TAKEOFF, SWITCH_WINDOW, runChecks, strafesOf, switchesOf, turnStart, keyDir, median, strafing, turnBtn, interior, jumpRange };
