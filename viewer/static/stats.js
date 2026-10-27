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

const LAG_MAX = 10;

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

	let g = 0;
	let id = 0;
	let air = 0;
	let turning = 0;
	const ratios = [];
	let strafes = 0;
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
			}
		}
		g += jg;
		id += jid;
		const sts = strafesOf(d, j, endIdx);
		for (const st of sts) for (const i of interior(d, st, 2)) if (Number.isFinite(d.ratio[i])) ratios.push(d.ratio[i]);
		const isLanded = j.e <= endIdx && j.e < d.n;
		if (isLanded) strafes += sts.length;
		return { num: j.num, pct: j.pct, sync: syncOver(d, [[s, e]], lag).sync, strafes: sts.length, landed: isLanded, takeoff: j.takeoff, land: j.land };
	});

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
	return {
		gainPct: id > 0 ? (100 * g) / id : NaN,
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

if (typeof module !== 'undefined') module.exports = { LAG_MAX, keyLag, syncOver, summarize };
