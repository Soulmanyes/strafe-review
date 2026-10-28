'use strict';
// Strafe Review: summary stats of one recording for the compare page (compare.js) and the node harness
// (viewer/check_stats.js). Uses data.js and checks.js; no DOM here.
//
// Definitions match the rest of the viewer, so the same jump shows the same number everywhere:
//  - gain %: sum(gain) / sum(ideal) over a jump's rows, as findJumps() and the jump strip.
//  - angle: median yawRatio of strafe middles (2 ticks skipped at each end, +left/+right ticks out), as the drill page.
//  - strafes: strafesOf(). Rows judged: strafing() (air, 100+ u/s, no collision).
//  - sync: share of strafing ticks with a turn where the held key (A or D alone) matches the turn side.
//    +left/+right ticks are left out. Keys are shifted by the recording's key lag first (keyLag()).
//  - swaps (swapsOf()): one per pair of strafes in a row inside a jump, see there.
//  - band: a strafe-middle tick (as the angle) is in band at yawRatio 0.85-1.15, the yaw lane's optimal band.

const LAG_MAX = 10;
const BAND_LO = 0.85;
const BAND_HI = 1.15;
const SWAP_HALF = 3; // efficiency window: the reversal tick and 3 ticks each side
const SWAP_PEAK = 6; // over/undershoot: ticks after the reversal searched for the peak turn speed
const SWAP_SEARCH = 12;
const DIP_PCT = 85; // gain dip threshold when the run has no gain % of its own (else the run's gain % is used)
const DIP_FIND = 4; // the dip's lowest tick is searched this far each side of the window centre // the in-band tick before and after the reversal must be this close, else time is unknown

// Raw turn speed of row i as a share of the optimal, signed so + is turning `dir` (NaN when unknown)
function rawRatio(d, i, dir) {
	return i >= 0 && i < d.n && d.opt[i] > 0 && Number.isFinite(d.yawd[i]) ? (dir * d.yawd[i]) / d.opt[i] : NaN;
}

// Ticks from the key switch nearest strafe B's start to that start (the switch check's rule), or null
function keyOffOf(d, sw, B) {
	let best = null;
	for (const w of sw) {
		if (w.dir !== B.dir) continue;
		const off = d.tick[w.i] - d.tick[B.i0];
		if (Math.abs(off) <= SWITCH_WINDOW && (best === null || Math.abs(off + 1) < Math.abs(best + 1))) best = off;
	}
	return best;
}

// Strafe direction swaps of one jump. A swap is two strafes in a row (strafesOf()). With missed ticks
// within SWAP_SEARCH ticks of the reversal it gets gap: true and only keyOff (the rest is NaN). Its reversal is the first row from 4 ticks before the new strafe's start where the raw
// per-tick yaw turns the new way (the 5-tick average lags and smears it). Per swap:
//  - time: ticks from the last old-side tick at 85 %+ of optimal to the first new-side one (fall + ramp).
//  - eff / lost: gain over ideal on the 7 rows centred on the reversal, and ideal - gain there in u/s.
//    Other players' recordings: centred `lag` rows earlier (keyLag()). Their angles trail the velocity by
//    about that much (gain by tick offset dips 6 ticks before the angle reversal on replays, at it on own runs).
//  - peak: the highest 2-tick average of the new-side turn over the 6 ticks from the reversal, vs optimal.
//    Over 1.15 = overshoot, under 0.85 = undershoot. Not judged when +left/+right is held (fixed turn rate).
//  - dip / dipDown / dipUp / dipLow: the gain dip. Lowest per-tick gain % within 4 rows of the window
//    centre (dipLow), ticks under dipPct (the run's gain %) in a row before it (down) and after it (up);
//    dip = down + 1 + up.
//  - keyOff: the key switch nearest the reversal, by the switch check's rule (target -1). Null for replays
//    and, as in the check, when either strafe has missed ticks anywhere.
// btn = +left/+right held on either side of the reversal (the owner's prestrafe into jump 1).
function swapsOf(d, j, endIdx, replay, lag = 0, dipPct = DIP_PCT) {
	const sts = strafesOf(d, j, endIdx);
	const sw = replay ? [] : switchesOf(d, j, endIdx);
	const out = [];
	for (let k = 1; k < sts.length; k++) {
		const A = sts[k - 1];
		const B = sts[k];
		// missed ticks anywhere near the reversal spoil the timing; elsewhere in the strafes they don't matter
		const lo = Math.max(A.i0, B.i0 - SWAP_SEARCH - 4);
		const hi = Math.min(B.i1, B.i0 + SWAP_SEARCH);
		let gap = false;
		for (let i = lo + 1; i <= hi; i++) if (d.gap[i] > 0) gap = true;
		if (gap) {
			// still counted for the key switch, which the switch check judges here too
			out.push({ jump: j.num, k, dir: B.dir, i: B.i0, gap: true, fall: NaN, ramp: NaN, time: NaN, eff: NaN, lost: 0, dip: NaN, dipDown: NaN, dipUp: NaN, dipLow: NaN, peak: NaN, keyOff: replay || A.gap || B.gap ? null : keyOffOf(d, sw, B), btn: false });
			continue;
		}
		let rev = B.i0;
		for (let i = Math.max(A.i0, B.i0 - 4); i <= B.i0; i++) {
			if (Math.sign(d.yawd[i]) === B.dir && Math.abs(d.yawd[i]) > 0.05) {
				rev = i;
				break;
			}
		}
		let fall = NaN;
		for (let i = rev - 1; i >= A.i0 && d.tick[rev] - d.tick[i] <= SWAP_SEARCH; i--) {
			if (rawRatio(d, i, A.dir) >= BAND_LO) {
				fall = d.tick[rev] - d.tick[i];
				break;
			}
		}
		let ramp = NaN;
		for (let i = rev; i <= B.i1 && d.tick[i] - d.tick[rev] <= SWAP_SEARCH; i++) {
			if (rawRatio(d, i, B.dir) >= BAND_LO) {
				ramp = d.tick[i] - d.tick[rev];
				break;
			}
		}
		let g = 0;
		let id = 0;
		// a replay's view angles trail its movement by its key lag, so the speed dip sits that many rows earlier
		const mid = rev - lag;
		for (let i = Math.max(mid - SWAP_HALF, 0); i <= Math.min(mid + SWAP_HALF, d.n - 1); i++) {
			if (!strafing(d, i) || !Number.isFinite(d.gain[i]) || !Number.isFinite(d.ideal[i])) continue;
			g += d.gain[i];
			id += d.ideal[i];
		}
		// Gain dip: the lowest gain % tick near the window centre, and the ticks under dipPct (the run's own
		// gain %) in a row before it (down) and after it (up). No tick under it = no dip (0 / 0, low point kept).
		const pctAt = (i) => (i >= 0 && i < d.n && d.gap[i] === 0 && strafing(d, i) && d.ideal[i] > 0 && Number.isFinite(d.gain[i]) ? (100 * d.gain[i]) / d.ideal[i] : NaN);
		let low = -1;
		for (let i = mid - DIP_FIND; i <= mid + DIP_FIND; i++) if (Number.isFinite(pctAt(i)) && (low < 0 || pctAt(i) < pctAt(low))) low = i;
		let dipDown = NaN;
		let dipUp = NaN;
		const dipLow = low < 0 ? NaN : pctAt(low);
		if (low >= 0) {
			dipDown = 0;
			dipUp = 0;
			if (dipLow < dipPct) {
				for (let i = low - 1; pctAt(i) < dipPct; i--) dipDown++;
				for (let i = low + 1; pctAt(i) < dipPct; i++) dipUp++;
			}
		}
		const dip = low < 0 ? NaN : dipLow < dipPct ? dipDown + 1 + dipUp : 0;
		const btn = turnBtn(d, A.i1) || turnBtn(d, rev) || turnBtn(d, B.i0);
		let peak = NaN;
		if (!btn) {
			for (let i = rev + 1; i < rev + SWAP_PEAK && i <= B.i1; i++) {
				const r = (rawRatio(d, i - 1, B.dir) + rawRatio(d, i, B.dir)) / 2;
				if (Number.isFinite(r) && !(r <= peak)) peak = r;
			}
		}
		const keyOff = replay || A.gap || B.gap ? null : keyOffOf(d, sw, B);
		out.push({ jump: j.num, k, dir: B.dir, i: rev, gap: false, fall, ramp, time: fall + ramp, eff: id > 0 ? (100 * g) / id : NaN, lost: Math.max(id - g, 0), dip, dipDown, dipUp, dipLow, peak, keyOff, btn });
	}
	return out;
}

// Ticks the keys run ahead of the turn: the shift (-LAG_MAX..LAG_MAX) where the key held `lag` ticks
// earlier matches the turn best. Replays come out around +3 to +7 (their keys lead the angles).
function keyLag(d, ranges) {
	let best = { lag: 0, sync: -1 };
	for (let lag = -LAG_MAX; lag <= LAG_MAX; lag++) {
		const s = syncOver(d, ranges, lag);
		if (s.n && s.sync > best.sync + 1e-9) best = { lag, sync: s.sync };
	}
	return best.lag;
}

// Sync over row ranges [[i0, i1)...] with keys taken `lag` ticks earlier (same tick count, no missed ticks between)
function syncOver(d, ranges, lag) {
	let hit = 0;
	let n = 0;
	for (const [i0, i1] of ranges) {
		for (let i = i0; i < i1; i++) {
			const k = i - lag;
			if (k < 0 || k >= d.n || d.tick[i] - d.tick[k] !== lag) continue;
			if (!strafing(d, i) || !d.ideal_key[i] || turnBtn(d, i) || turnBtn(d, k)) continue;
			n++;
			if (keyDir(d.buttons[k]) === d.ideal_key[i]) hit++;
		}
	}
	return { sync: n ? (100 * hit) / n : NaN, n };
}

function summarize(head, d, jumps) {
	const endIdx = runEnd(head, d);
	const p = Math.min(head.preRows || 0, d.n - 1);
	const run = jumps.filter((j) => j.num > 0 && j.s <= endIdx);
	const landed = run.filter((j) => j.e <= endIdx && j.e < d.n);
	const ranges = run.map((j) => jumpRange(j, endIdx));
	const lag = keyLag(d, ranges);

	const replay = isOther(head);
	let g = 0;
	let id = 0;
	let air = 0;
	let turning = 0;
	const ratios = [];
	let strafes = 0;
	const lens = [];
	const yawMid = [];
	const side = { 1: { g: 0, id: 0 }, '-1': { g: 0, id: 0 } };
	let lost = 0;
	let wAir = 0;
	let noKey = 0;
	let btnTicks = 0;
	const swaps = [];
	const perJump = run.map((j) => {
		const [s, e] = jumpRange(j, endIdx);
		let jg = 0;
		let jid = 0;
		for (let i = s; i < e; i++) {
			if (Number.isFinite(d.gain[i]) && Number.isFinite(d.ideal[i])) {
				jg += d.gain[i];
				jid += d.ideal[i];
			}
			if (strafing(d, i)) {
				air++;
				if (d.ideal_key[i]) turning++;
				if (d.buttons[i] & BIT.FORWARD) wAir++;
				if (turnBtn(d, i)) btnTicks++;
				else if (d.ideal_key[i] && !keyDir(d.buttons[i])) noKey++;
				if (Number.isFinite(d.gain[i]) && Number.isFinite(d.ideal[i])) {
					lost += d.ideal[i] - d.gain[i];
					if (d.ideal_key[i]) {
						side[d.ideal_key[i]].g += d.gain[i];
						side[d.ideal_key[i]].id += d.ideal[i];
					}
				}
			}
		}
		g += jg;
		id += jid;
		const sts = strafesOf(d, j, endIdx);
		for (const st of sts) {
			for (const i of interior(d, st, 2)) {
				if (Number.isFinite(d.ratio[i])) ratios.push(d.ratio[i]);
				if (Number.isFinite(d.yaws[i])) yawMid.push(Math.abs(d.yaws[i]));
			}
			if (!st.gap && st.i1 > st.i0) lens.push(st.n);
		}
		const isLanded = j.e <= endIdx && j.e < d.n;
		if (isLanded) strafes += sts.length;
		return { num: j.num, pct: j.pct, sync: syncOver(d, [[s, e]], lag).sync, strafes: sts.length, landed: isLanded, takeoff: j.takeoff, land: j.land };
	});

	// swaps after the loop: the gain dip is judged against the run's own gain %
	const runPct = id > 0 ? (100 * g) / id : NaN;
	for (const j of run) swaps.push(...swapsOf(d, j, endIdx, replay, replay ? lag : 0, Number.isFinite(runPct) ? runPct : DIP_PCT));

	let vmax = 0;
	let vsum = 0;
	let vn = 0;
	for (let i = p; i <= endIdx; i++) {
		if (!Number.isFinite(d.speed[i])) continue;
		vmax = Math.max(vmax, d.speed[i]);
		vsum += d.speed[i];
		vn++;
	}
	const j1 = perJump.find((j) => j.num === 1) || null;
	const share = (fn) => (ratios.length ? (100 * ratios.filter(fn).length) / ratios.length : NaN);
	const fin = (vs) => vs.filter(Number.isFinite);
	const lj = perJump.filter((j) => j.landed && Number.isFinite(j.pct));
	const pcts = lj.map((j) => j.pct);
	const mean = pcts.length ? pcts.reduce((a, v) => a + v, 0) / pcts.length : NaN;
	const timed = swaps.filter((w) => !w.gap);
	const pk = swaps.filter((w) => Number.isFinite(w.peak));
	const ko = swaps.filter((w) => w.keyOff !== null);
	const swapLost = swaps.reduce((a, w) => a + w.lost, 0);
	let airRun = 0;
	let rowsRun = 0;
	for (let i = p; i <= endIdx; i++) {
		rowsRun++;
		if (!d.ground[i]) airRun++;
	}
	return {
		replay,
		lost: Math.max(lost, 0),
		bestJump: lj.length ? lj.reduce((a, j) => (j.pct > a.pct ? j : a)) : null,
		worstJump: lj.length ? lj.reduce((a, j) => (j.pct < a.pct ? j : a)) : null,
		spread: pcts.length > 1 ? Math.sqrt(pcts.reduce((a, v) => a + (v - mean) ** 2, 0) / (pcts.length - 1)) : NaN,
		leftPct: side[1].id > 0 ? (100 * side[1].g) / side[1].id : NaN,
		rightPct: side[-1].id > 0 ? (100 * side[-1].g) / side[-1].id : NaN,
		inBand: share((r) => r >= BAND_LO && r <= BAND_HI),
		tooFast: share((r) => r > BAND_HI),
		tooSlow: share((r) => r < BAND_LO),
		yawMid: yawMid.length ? median(yawMid) : NaN,
		strafeLen: lens.length ? median(lens) : NaN,
		airPct: rowsRun ? (100 * airRun) / rowsRun : NaN,
		wAirPct: air ? (100 * wAir) / air : NaN,
		noKeyPct: air - btnTicks > 0 ? (100 * noKey) / (air - btnTicks) : NaN,
		btnTicks,
		swaps,
		swapTime: median(fin(swaps.map((w) => w.time))),
		swapEff: median(fin(swaps.map((w) => w.eff))),
		dip: median(fin(swaps.map((w) => w.dip))),
		dipDown: median(fin(swaps.map((w) => w.dipDown))),
		dipUp: median(fin(swaps.map((w) => w.dipUp))),
		dipLow: median(fin(swaps.map((w) => w.dipLow))),
		swapLost,
		swapLostShare: lost > 0 ? (100 * swapLost) / lost : NaN,
		swapsTimed: timed.length,
		worstSwap: timed.length ? timed.reduce((a, w) => (w.lost > a.lost ? w : a)) : null,
		peak: pk.length ? median(pk.map((w) => w.peak)) : NaN,
		over: pk.filter((w) => w.peak > BAND_HI).length,
		under: pk.filter((w) => w.peak < BAND_LO).length,
		judged: pk.length,
		keyOff: ko.length ? median(ko.map((w) => w.keyOff)) : NaN,
		keyOnTarget: ko.length ? (100 * ko.filter((w) => w.keyOff >= -2 && w.keyOff <= 0).length) / ko.length : NaN,
		gainPct: runPct,
		sync: syncOver(d, ranges, lag).sync,
		lag,
		angle: ratios.length ? median(ratios) : NaN,
		strafesPerJump: landed.length ? strafes / landed.length : NaN,
		turnPct: air ? (100 * turning) / air : NaN,
		jumps: run.length,
		landed: landed.length,
		j1,
		speedMax: vmax,
		speedAvg: vn ? vsum / vn : NaN,
		speedEnd: d.speed[endIdx],
		perJump,
		endIdx
	};
}

if (typeof module !== 'undefined') module.exports = { LAG_MAX, BAND_LO, BAND_HI, DIP_PCT, keyLag, syncOver, swapsOf, summarize };
