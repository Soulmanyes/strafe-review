// Run stat rows, shared by the main page's Run stats cards and the compare page's Stats table so both
// show the same numbers from summarize() (stats.js). Loaded after data.js, checks.js, stats.js and mouse.js.
//
// runStatRows(ctx) gives cards [{ title, rows }]. ctx: { cms(r, deg) -> ' · x cm/s' or '', sw: the switch
// check's { early, late }, zoomJump(num, r), zoomSwap(w, r) }; the zoom functions are optional (no click
// without them). A row: name, desc (plain words), tip (how it is measured), v(s, r) -> text,
// sub(s, r) -> small second line (compare only), num(s, r) -> number for ranking, best: 'max' | 'min' |
// a target number (closest wins), need: 'tick' | 'keys', click(s, r). s = summarize()'s result,
// r = { head, d, path, mistakes }. Rows without best are not ranked (no better direction).

// need: 'tick' rows are left out for a spectated live run (speed only every few ticks), 'keys' rows for
// other players' recordings (their keys run ahead)
function skipRow(r, need) {
	return (need === 'tick' && r.d.coarse) || (need === 'keys' && (r.d.coarse || isOther(r.head)));
}

function skipWhy(r) {
	return r.d.coarse ? 'spectated: speed every few ticks' : 'not run (replay keys run ahead)';
}

// The switch check's early/late thresholds from the saved check settings, so counts match the Mistakes list
function switchThresholds(settings) {
	const sc = (settings && settings.switch) || {};
	return Object.fromEntries(Object.entries(CHECKS.find((c) => c.id === 'switch').params).map(([k, p]) => [k, sc[k] === undefined ? p.v : sc[k]]));
}

function runStatRows(ctx) {
	const n = (v, k = 1, unit = '') => (Number.isFinite(v) ? `${v.toFixed(k)}${unit}` : '–');
	const fin = (r) => r.head.reason === 'finish';
	const endOf = (h) => (h.reason === 'finish' && h.runTime ? `${h.runTime.toFixed(3)} s` : REASONS[h.reason] || h.reason || '?');
	const jumpOf = (j) => (j ? `jump ${j.num} · ${n(j.pct, 2, ' %')}` : '–');
	const swapOf = (w) => (w ? `jump ${w.jump} swap ${w.k}${w.btn ? ' (+left/right)' : ''} · ${n(w.lost, 1, ' u/s')}` : '–');
	const dist = (s, r) => pathDistance(r.path, Math.min(r.head.preRows || 0, r.d.n - 1), s.endIdx);
	const derived = (s, r) => (r.d.derived ? 'rebuilt from speed' : '');
	const lostToMistakes = (r) => r.mistakes.reduce((a, m) => a + m.lost, 0);
	const keyed = (s) => s.swaps.filter((w) => w.keyOff !== null);
	const early = (s) => keyed(s).filter((w) => w.keyOff <= -ctx.sw.early).length;
	const late = (s) => keyed(s).filter((w) => w.keyOff >= ctx.sw.late).length;
	const zj = ctx.zoomJump && ((j, r) => j && ctx.zoomJump(j.num, r));
	return [
		{
			title: 'Run',
			rows: [
				{ name: 'End', desc: 'Your finish time, or how the attempt stopped.', tip: 'Finish time, or how the attempt ended', v: (s, r) => endOf(r.head), num: (s, r) => (fin(r) ? r.head.runTime : NaN), best: 'min' },
				{ name: 'Jumps landed', desc: 'Jumps from jump 1 that touched ground again before the run ended.', tip: 'Jumps from jump 1 on that landed before the run end', v: (s) => `${s.landed} of ${s.jumps}` },
				{ name: 'Missed ticks', desc: 'Ticks the recorder didn\'t see (game frames slower than ticks). Their numbers are guessed or left out.', tip: 'Ticks the HUD missed inside the run (frames slower than ticks)', v: (s, r) => String(runGaps(r.head, r.d)) },
				{ name: 'Distance', desc: 'How far you travelled (horizontal only). Shorter = tighter line.', tip: 'Horizontal distance from the timer start to the run end, built up from speed (teleports add nothing). Ranked between finished runs only', v: (s, r) => `${Math.round(dist(s, r))} u`, num: (s, r) => (fin(r) ? dist(s, r) : NaN), best: 'min' },
				{ name: 'Air time', desc: 'Share of the run spent in the air. Close to 100 % = clean bhops.', tip: 'Share of the run ticks in the air (vz not 0)', v: (s) => n(s.airPct, 1, ' %'), num: (s) => s.airPct, best: 'max', need: 'tick' }
			]
		},
		{
			title: 'Gain',
			rows: [
				{ name: 'Gain %', desc: 'How much of the speed you could have gained you actually gained. 100 % = perfect strafing.', tip: 'Sum of gain over sum of ideal gain, every jump from jump 1 on (as the jump strip)', v: (s) => n(s.gainPct, 2, ' %'), sub: derived, num: (s) => s.gainPct, best: 'max' },
				{
					name: 'CS:S gain (SSJ)',
					desc: 'Gain % the way CS:S servers show it in chat (the SSJ plugin). It scores how square your move is to your speed each tick, so it reads lower than Momentum\'s gain %. Top replays about 80-88 %.',
					tip: 'Average over every tick of jumps 1+ of (30 - |p|) / 30 (0 when p is 30+), p = previous velocity along the move direction, taken from the velocity change. SSJ\'s wall-touch rule is left out. Per jump in the jump strip',
					v: (s) => n(s.ssjPct, 2, ' %'),
					num: (s) => s.ssjPct,
					best: 'max',
					need: 'tick'
				},
				{ name: 'Speed lost', desc: 'Speed you would have had on top with perfect strafing, added up over the run.', tip: 'Sum of ideal - gain over every strafing tick (air, 100+ u/s, no wall hit): speed you could have had. Ranked between finished runs only', v: (s) => n(s.lost, 0, ' u/s'), num: (s, r) => (fin(r) ? s.lost : NaN), best: 'min', need: 'tick' },
				{ name: 'Best jump', desc: 'Your jump with the highest gain %. Click to see it.', tip: 'Landed jump with the highest gain %', v: (s) => jumpOf(s.bestJump), click: zj && ((s, r) => zj(s.bestJump, r)) },
				{ name: 'Worst jump', desc: 'Your jump with the lowest gain %. Click to see it.', tip: 'Landed jump with the lowest gain %', v: (s) => jumpOf(s.worstJump), click: zj && ((s, r) => zj(s.worstJump, r)) },
				{ name: 'Spread', desc: 'How much gain % changes from jump to jump. Lower = more consistent.', tip: 'Standard deviation of the landed jumps\' gain %: lower = more even jump to jump', v: (s) => n(s.spread, 1, ' %'), num: (s) => s.spread, best: 'min' },
				{ name: 'Left / right', desc: 'Gain % while turning left vs turning right. A big difference means one side is weaker.', tip: 'Gain % on ticks turning left (A side) and turning right (D side). Ranked by the smallest difference', v: (s) => `${n(s.leftPct, 1)} / ${n(s.rightPct, 1)} %`, num: (s) => Math.abs(s.leftPct - s.rightPct), best: 'min', need: 'tick' }
			]
		},
		{
			title: 'Speed',
			rows: [
				{ name: 'Max', desc: 'Top horizontal speed in the run.', v: (s) => n(s.speedMax, 0, ' u/s'), num: (s) => s.speedMax, best: 'max' },
				{ name: 'Average', desc: 'Average horizontal speed over the run.', tip: 'Horizontal speed averaged over the run ticks', v: (s) => n(s.speedAvg, 0, ' u/s'), num: (s) => s.speedAvg, best: 'max' },
				{ name: 'At the end', desc: 'Speed at the finish (or where the recording stops).', tip: 'At the finish, or at the end of the recording. Ranked between finished runs only', v: (s) => n(s.speedEnd, 0, ' u/s'), sub: (s, r) => (fin(r) ? 'at the finish' : 'at the end of the recording'), num: (s, r) => (fin(r) ? s.speedEnd : NaN), best: 'max' },
				{ name: 'Jump 1 takeoff', desc: 'Speed leaving the start zone ground: how good the prestrafe was.', v: (s) => (s.j1 ? n(s.j1.takeoff, 1, ' u/s') : '–'), num: (s) => (s.j1 ? s.j1.takeoff : NaN), best: 'max' },
				{ name: 'Jump 1 landing', desc: 'Speed when jump 1 lands. Takeoff + what you gained on jump 1.', v: (s) => (s.j1 && s.j1.landed ? n(s.j1.land, 1, ' u/s') : '–'), num: (s) => (s.j1 && s.j1.landed ? s.j1.land : NaN), best: 'max' },
				{ name: 'Jump 1 gain', desc: 'Gain % on jump 1 alone, and the CS:S (SSJ) gain for it. Click to see it.', v: (s) => (s.j1 ? `${n(s.j1.pct, 2, ' %')}${Number.isFinite(s.j1.ssj) ? ` · CS:S ${n(s.j1.ssj, 1, ' %')}` : ''}` : '–'), num: (s) => (s.j1 ? s.j1.pct : NaN), best: 'max', click: zj && ((s, r) => zj(s.j1, r)) }
			]
		},
		{
			title: 'Turning',
			rows: [
				{ name: 'Angle (yawRatio)', desc: 'How fast you turn compared with the best turn speed, mid-strafe. 1 = perfect, below = too slow, above = too fast.', tip: 'Median yawRatio of strafe middles (2 ticks skipped at each end, +left/+right ticks out). 1 = optimal', v: (s) => n(s.angle, 2), sub: derived, num: (s) => s.angle, best: 1, need: 'tick' },
				{ name: 'In optimal band', desc: 'Mid-strafe ticks where your turn speed is within 15 % of perfect. Higher = better.', tip: `Strafe-middle ticks at yawRatio ${BAND_LO}-${BAND_HI} (the yaw lane's band)`, v: (s) => n(s.inBand, 1, ' %'), num: (s) => s.inBand, best: 'max', need: 'tick' },
				{ name: 'Too slow / too fast', desc: 'Mid-strafe ticks turning too slowly (under 85 %) / too quickly (over 115 %).', tip: `Strafe-middle ticks under ${BAND_LO} / over ${BAND_HI}. Ranked by the two added up`, v: (s) => `${n(s.tooSlow, 1)} / ${n(s.tooFast, 1)} %`, num: (s) => s.tooSlow + s.tooFast, best: 'min', need: 'tick' },
				{ name: 'Turn speed', desc: 'Your usual mid-strafe turn speed, in degrees per tick and mouse cm per second.', tip: 'Median turn speed of strafe middles (5-tick average), and in mouse terms when the DPI is set (a replay at your sens)', v: (s, r) => `${n(s.yawMid, 2, '°/t')}${ctx.cms(r, s.yawMid)}`, need: 'tick' },
				{ name: 'Strafes per jump', desc: 'How many separate turns (one side each) you make per jump.', tip: 'Turns to one side per landed jump', v: (s) => n(s.strafesPerJump, 1), need: 'tick' },
				{ name: 'Strafe length', desc: 'Usual length of one strafe (one turn to one side), in ticks.', tip: 'Median ticks of one strafe (one turn to one side)', v: (s) => n(s.strafeLen, 0, ' t'), need: 'tick' },
				{ name: 'Air time turning', desc: 'Share of the air time you are actually turning. Not turning = gaining almost nothing.', tip: 'Strafing ticks with a turn of more than 0.3°/tick', v: (s) => n(s.turnPct, 1, ' %'), num: (s) => s.turnPct, best: 'max', need: 'tick' },
				{ name: '+left/+right ticks', desc: 'Ticks turned with the +left/+right keys (fixed speed), e.g. your prestrafe. Left out of the turning numbers.', tip: 'Strafing ticks with a turn button held (fixed cl_yawspeed turn, left out of the angle numbers)', v: (s) => String(s.btnTicks), need: 'tick' }
			]
		},
		{
			title: 'Swaps (strafe direction changes)',
			rows: [
				{ name: 'Swaps', desc: 'Times you switch from turning one way to the other inside a jump.', tip: 'Strafe direction changes inside jumps, without missed ticks near them', v: (s) => String(s.swapsTimed), need: 'tick' },
				{ name: 'Swap time', desc: 'How long a switch takes: ticks from turning at full speed one way to full speed the other way. Shorter = better (top replays about 4).', tip: 'Median ticks from the last tick turning at 85 %+ of optimal one way to the first one the other way', v: (s) => n(s.swapTime, 1, ' t'), num: (s) => s.swapTime, best: 'min', need: 'tick' },
				{ name: 'Swap efficiency', desc: 'Gain % (same meaning as above) over just the 7 ticks around a switch. Everyone loses some here; low = you lose a lot while changing direction (top replays about 85 %).', tip: "Median gain % of ideal over the 7 ticks centred on each reversal. Other players' recordings: centred their key lag earlier, because their view angles trail their movement", v: (s) => n(s.swapEff, 1, ' %'), num: (s) => s.swapEff, best: 'max', need: 'tick' },
				{
					name: 'Swap vs strafe gain',
					desc: 'Gain % around switches next to gain % in the rest of your strafes, and the gap between them. Shows how much worse your swaps are than your strafing. Smaller gap = better.',
					tip: 'Gain % of ideal pooled over all 7-tick swap windows (each tick once) vs over the strafing ticks outside every window, and swap minus strafe in percentage points. Swaps with missed ticks are left out of both. Ranked by the gap',
					v: (s) => `${n(s.swapPct, 1, ' %')} vs ${n(s.midPct, 1, ' %')} · ${Number.isFinite(s.swapPct - s.midPct) ? `${s.swapPct - s.midPct > 0 ? '+' : ''}${(s.swapPct - s.midPct).toFixed(1)} pts` : '–'}`,
					num: (s) => s.swapPct - s.midPct,
					best: 'max',
					need: 'tick'
				},
				{
					name: 'Gain dip',
					desc: 'How long your gain stays below this run\'s average gain % at a switch, split into dropping (before the worst tick), the worst tick itself and recovering (after it). Averages, so the parts add up. Shorter = faster swap.',
					tip: "Per swap: the lowest gain % tick within 4 ticks of the swap window's centre, then the ticks in a row under the run's gain % (Gain card) before it (down) and after it (up); dip = down + 1 + up, 0 when no tick is under it. Averages over the swaps: down + low + up = total, where low is the share of swaps with a dip at all",
					v: (s) => `${n(s.dip, 1, ' t')} (${n(s.dipDown, 1)} down · ${n(s.dipLowN, 1)} low · ${n(s.dipUp, 1)} up)`,
					num: (s) => s.dip,
					best: 'min',
					need: 'tick'
				},
				{
					name: 'Dip low point',
					desc: 'Gain % on the worst tick of a switch. 0 % = no speed gained that tick; below 0 = losing speed (top replays about 15 %).',
					tip: 'Median of each swap\'s lowest per-tick gain % (gain / ideal) near the reversal',
					v: (s) => n(s.dipLow, 0, ' %'),
					num: (s) => s.dipLow,
					best: 'max',
					need: 'tick'
				},
				{ name: 'Lost at swaps', desc: 'Speed lost in those few ticks around switches, and how much of all your lost speed that is.', tip: 'Ideal - gain summed over those 7-tick windows, and its share of all speed lost. Ranked by the share', v: (s) => `${n(s.swapLost, 0, ' u/s')} · ${n(s.swapLostShare, 0, ' %')}`, num: (s) => s.swapLostShare, best: 'min', need: 'tick' },
				{ name: 'Peak after swap', desc: 'How fast you turn just after a switch compared with perfect. 100 % = perfect; under = slow to get going, over = jerking too hard.', tip: `Median of the fastest 2-tick turn in the 6 ticks after each reversal, vs optimal (100 % = optimal). +left/+right swaps not judged`, v: (s) => n(100 * s.peak, 0, ' %'), num: (s) => s.peak, best: 1, need: 'tick' },
				{ name: 'Over / undershoot', desc: 'Switches where you turn too hard right after (over 115 %) / too gently (under 85 %).', tip: `Swaps whose peak is over ${BAND_HI * 100} % / under ${BAND_LO * 100} % of optimal, of the swaps judged. Ranked by their share of the swaps judged`, v: (s) => `${s.over} / ${s.under} of ${s.judged}`, num: (s) => (s.judged ? (s.over + s.under) / s.judged : NaN), best: 'min', need: 'tick' },
				{ name: 'Worst swap', desc: 'The switch where you lost the most speed. Click to see it.', tip: 'The swap with the most speed lost in its 7-tick window. (+left/right): a turn button was held, e.g. the prestrafe into jump 1', v: (s) => swapOf(s.worstSwap), click: ctx.zoomSwap && ((s, r) => s.worstSwap && ctx.zoomSwap(s.worstSwap, r)), need: 'tick' }
			]
		},
		{
			title: 'Keys',
			rows: [
				{
					name: 'Sync (keys vs turn)', desc: 'Share of turning ticks where the right strafe key (A or D alone) is held. Higher = better.',
					tip: "Strafing ticks where A or D alone matches the turn side, keys shifted by the best lag. +left/+right ticks out. Not the game's sync number",
					v: (s, r) => `${n(s.sync, 1, ' %')}${isOther(r.head) ? ' approx.' : ''}`,
					sub: (s) => `keys ${s.lag >= 0 ? 'ahead' : 'behind'} ${Math.abs(s.lag)} t`,
					num: (s) => s.sync,
					best: 'max',
					need: 'tick'
				},
				{ name: 'Key lag', desc: 'How many ticks your keys come before your mouse turn. Your runs: about 1.', tip: 'Ticks the keys run ahead of the turn (best match). Own runs about 1, replays 5-7', v: (s) => `${s.lag} t`, need: 'tick' },
				{ name: 'Switch vs reversal', desc: 'When you press the new key compared with when your mouse changes direction. Target -1 (one tick before).', tip: 'Median ticks from the key switch to the reversal, as the switch check (target -1: one tick before)', v: (s) => n(s.keyOff, 1, ' t'), num: (s) => s.keyOff, best: -1, need: 'keys' },
				{ name: 'Switch on target', desc: 'Key switches 0-2 ticks before the mouse changes direction.', tip: 'Switches 0-2 ticks before the reversal', v: (s) => n(s.keyOnTarget, 0, ' %'), num: (s) => s.keyOnTarget, best: 'max', need: 'keys' },
				{
					name: 'Early / late', desc: 'Key switches too early / too late, by the Check settings thresholds (same as the Mistakes list).',
					tip: `Switches ${ctx.sw.early}+ ticks before / ${ctx.sw.late}+ ticks after the reversal (the switch check's thresholds in Check settings). Ranked by their share of the switches`,
					v: (s) => `${early(s)} / ${late(s)}`,
					num: (s) => (keyed(s).length ? (early(s) + late(s)) / keyed(s).length : NaN),
					best: 'min',
					need: 'keys'
				},
				{ name: 'No key while turning', desc: 'Turning ticks with no strafe key (or both). Those ticks gain nothing.', tip: 'Turning strafing ticks with neither or both of A and D (+left/+right ticks out)', v: (s) => n(s.noKeyPct, 1, ' %'), num: (s) => s.noKeyPct, best: 'min', need: 'keys' },
				{ name: 'W in the air', desc: 'Air ticks with W held. W while strafing usually costs gain.', tip: 'Strafing ticks with W held', v: (s) => n(s.wAirPct, 1, ' %'), num: (s) => s.wAirPct, best: 'min', need: 'keys' }
			]
		},
		{
			title: 'Mistakes',
			rows: [
				{
					name: 'Found',
					desc: 'Mistakes found by the checks (listed below the path).',
					tip: 'Mistake checks with the current settings. Replays skip the key checks (their keys run ahead of the angles) and weak takeoff (it compares with your own median), so they are not ranked',
					v: (s, r) => (r.mistakes ? String(r.mistakes.length) : '–'),
					sub: (s, r) => (isOther(r.head) ? 'key checks and weak takeoff not run' : ''),
					num: (s, r) => (r.mistakes && !isOther(r.head) ? r.mistakes.length : NaN),
					best: 'min',
					need: 'tick'
				},
				{
					name: 'Speed lost to them',
					desc: 'Speed lost on the ticks of those mistakes.',
					v: (s, r) => (r.mistakes ? n(lostToMistakes(r), 1, ' u/s') : '–'),
					num: (s, r) => (r.mistakes && !isOther(r.head) ? lostToMistakes(r) : NaN),
					best: 'min',
					need: 'tick'
				}
			]
		}
	];
}

// Hover tip for a run stat: the plain description, then how it's measured. Shows at once (a title
// attribute waits about a second) and sits under the row. Needs a <div id="rs-tip" hidden> on the page.
function showRsTip(el, row) {
	const t = document.getElementById('rs-tip');
	t.replaceChildren();
	if (row.desc) t.append(Object.assign(document.createElement('div'), { textContent: row.desc }));
	if (row.tip) t.append(Object.assign(document.createElement('div'), { className: 'rs-tip-how', textContent: `Measured: ${row.tip}` }));
	t.hidden = false;
	const r = el.getBoundingClientRect();
	const w = t.offsetWidth;
	t.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
	const below = r.bottom + 4;
	t.style.top = `${below + t.offsetHeight > innerHeight - 8 ? r.top - t.offsetHeight - 4 : below}px`;
}

function hideRsTip() {
	document.getElementById('rs-tip').hidden = true;
}

if (typeof module !== 'undefined') module.exports = { runStatRows, skipRow, skipWhy, switchThresholds };
