// Strafe Review recorder. Loaded next to timer.ts (see layout/hud/timer.xml).
// Records one row per physics tick, keeps the last 2 s before the timer starts, and dumps
// each attempt to yaw.log as [panorama] SRREC lines when it ends. Reads only; sends no inputs.
//
// Wire format (format 1), all lines start with "SRREC <id> ":
//   <id> <i>/<n> <text>        chunk i of n; joined in order they form one JSON object
//   <id> end n=<n> chars=<c>   the last line of an attempt
// The JSON object holds head fields, "cols" (names of the comma-separated row fields),
// "rows" (rows joined by ';'), "events" and the end fields. See PLAN.md "Recording rules".

const TAG = 'SRREC';
const FORMAT = 1;

// TimerState from common/timer.ts (copied so this file has no imports)
const TIMER_PRIMED = 1;
const TIMER_RUNNING = 2;
const TIMER_FINISHED = 3;
const REPLAY_NONE = 0;

const PRESTART_SECONDS = 2;
// Rows kept after a non-finish end. mom_restart_stage ends the timer as DISABLED, the same
// state as practice mode, so the reason is judged from what happens in these rows.
const TAIL_SECONDS = 0.5;
const TAIL_WALL_MS = 2000; // give up waiting for tail ticks (game paused, menu)
// A reset teleports: horizontal speed falls to about 0 on the first tick after the end
// (361 to 0 in the 2026-10-27 test). Bhopping back into the start zone also primes the
// timer, but speed only bleeds off over several ticks (42, 39, 21, 3, 0).
const TELEPORT_SPEED = 5;
const TELEPORT_FROM = 30; // only judge a teleport when the run was moving at least this fast
const CHUNK_CHARS = 900; // $.Msg cuts at 2047 chars (probe v1); stay well under
const CHUNKS_PER_FRAME = 200; // long runs are spread over frames so a dump never hitches

const COLS = [
	'tick', // floor(game time / interval), raised to last + 1 when a new tick shows up inside the same number
	'gain', // GetLastTickStats().speedGain
	'ideal', // idealGain
	'ratio', // yawRatio
	'right', // strafeRight
	'vx',
	'vy',
	'vz',
	'yaw', // view angles, 3 decimals since yaw speed is a difference
	'pitch',
	'buttons', // physicalButtons (local player's keys, also while spectating)
	'move', // moveStatus: 0 air, 1 walk, 2 water, 3 waterjump
	'duck',
	'rtick' // replay curtick while a replay plays, else -1
];

interface Attempt {
	id: string;
	head: Record<string, unknown>;
	rows: string[];
	events: unknown[];
	preRows: number;
	gaps: number;
	runTime: number; // last runTime seen while running; reset and stop read 0 after the state change
	tail: Tail | null; // set once the timer stopped running; the attempt is dumped when it is over
	line: LineState;
}

interface Tail {
	state: number; // timer state the run ended in
	endRows: number; // rows up to and including the end tick
	endTick: number;
	endSpeed: number;
	untilTick: number;
	untilMs: number;
}

let interval = MomentumMovementAPI.GetTickInterval();
let ringSize = Math.ceil(PRESTART_SECONDS / interval);
let ring: string[] = [];
let attempt: Attempt | null = null;
let lastTick = -1;
let lastKey = '';
let lastState = MomentumTimerAPI.GetObservedTimerStatus().state;
const queue: string[] = [];
const reported = new Set<string>();

function msg(text: string) {
	$.Msg(`${TAG} ${text}`);
}

function r(value: number, digits: number) {
	return Number.isFinite(value) ? value.toFixed(digits) : 'nan';
}

// Mouse settings for turning degrees into mouse distance in the viewer. Read per attempt, so a
// sens change shows up between attempts. dpi is what Momentum's mouse settings page stored, or null.
function mouse() {
	const dpi = Number.parseFloat($.persistentStorage.getItem<string>('settings.mouseDPI') ?? '');
	return {
		sensitivity: GameInterfaceAPI.GetSettingFloat('sensitivity'),
		m_yaw: GameInterfaceAPI.GetSettingFloat('m_yaw'),
		cl_yawspeed: GameInterfaceAPI.GetSettingFloat('cl_yawspeed'),
		dpi: Number.isFinite(dpi) && dpi > 0 ? dpi : null
	};
}

// mouse(), or null if the HUD can't read the settings; the attempt is recorded either way
function mouseOrNull() {
	let out = null;
	guard('mouse', () => (out = mouse()));
	return out;
}

// Runs fn and logs its first exception only, so a throw every frame can't flood yaw.log
function guard(where: string, fn: () => void) {
	try {
		fn();
	} catch (e) {
		if (reported.has(where)) return;
		reported.add(where);
		msg(`err ${where} ${e}`);
	}
}

// New map: the tickrate may differ (surf 66, bhop 100). An attempt still open is cut here.
function onLevelInit() {
	endAttempt('level');
	lastState = MomentumTimerAPI.GetObservedTimerStatus().state;
	interval = MomentumMovementAPI.GetTickInterval();
	ringSize = Math.ceil(PRESTART_SECONDS / interval);
	ring = [];
	lastTick = -1;
}

function sample() {
	const stats = MomentumMovementAPI.GetLastTickStats();
	const vel = MomentumPlayerAPI.GetVelocity();
	// View angles change every frame, so they are not part of the new-tick key
	const key = `${stats.speedGain},${stats.idealGain},${stats.yawRatio},${stats.strafeRight},${vel.x},${vel.y},${vel.z}`;
	const floorTick = Math.floor(MomentumMovementAPI.GetCurrentTime() / interval);
	// Game time went back (map change, reload): start counting again
	if (floorTick < lastTick - 1) lastTick = -1;

	let tick: number;
	if (key !== lastKey) {
		tick = Math.max(floorTick, lastTick + 1);
	} else if (floorTick > lastTick && vel.x === 0 && vel.y === 0 && vel.z === 0) {
		tick = floorTick; // standing still: nothing changes, so time is the only tick signal
	} else {
		return;
	}
	lastKey = key;
	if (attempt && lastTick >= 0 && tick > lastTick + 1) attempt.gaps += tick - lastTick - 1;
	lastTick = tick;

	const ang = MomentumPlayerAPI.GetAngles();
	const move = MomentumMovementAPI.GetMoveHudData();
	const replaying = MomentumReplayAPI.GetReplayState() !== REPLAY_NONE;
	const row = [
		tick,
		r(stats.speedGain, 3),
		r(stats.idealGain, 3),
		r(stats.yawRatio, 3),
		stats.strafeRight,
		r(vel.x, 2),
		r(vel.y, 2),
		r(vel.z, 2),
		r(ang.y, 3),
		r(ang.x, 3),
		MomentumInputAPI.GetButtons().physicalButtons,
		move.moveStatus,
		MomentumPlayerAPI.IsDucking() ? 1 : 0,
		replaying ? MomentumReplayAPI.GetReplayProgress().curtick : -1
	].join(',');

	ring.push(row);
	if (ring.length > ringSize) ring.shift();
	if (attempt) {
		attempt.rows.push(row);
		const status = MomentumTimerAPI.GetObservedTimerStatus();
		if (status.state === TIMER_RUNNING) attempt.runTime = status.runTime;
		if (attempt.tail && tick >= attempt.tail.untilTick) finishTail();
	}
}

function hspeed() {
	const vel = MomentumPlayerAPI.GetVelocity();
	return Math.hypot(vel.x, vel.y);
}

// The run stopped without finishing: keep recording a short tail, then judge the reason
function startTail(state: number) {
	if (!attempt) return;
	attempt.tail = {
		state,
		endRows: attempt.rows.length,
		endTick: lastTick,
		endSpeed: hspeed(),
		untilTick: lastTick + Math.ceil(TAIL_SECONDS / interval),
		untilMs: Date.now() + TAIL_WALL_MS
	};
}

function finishTail() {
	const tail = attempt?.tail;
	if (!attempt || !tail) return;
	const timers = attempt.events.filter(
		(e) => (e as { kind: string }).kind === 'timer'
	) as { state: number }[];
	// IsInPracticeMode() read false half a second after practice mode stopped a run
	// (play test 2026-10-27), so the event decides
	const practice = attempt.events.some((e) => (e as { kind: string; on?: boolean }).kind === 'practice' && (e as { on: boolean }).on);
	// Loading a savestate stops the timer as DISABLED; its event comes on the same tick, just
	// before the timer's. Creating one mid-run fires the same event, but earlier.
	const savestate = attempt.events.some(
		(e) => (e as { kind: string; tick: number }).kind === 'savestate' && (e as { tick: number }).tick >= tail.endTick - 1
	);
	const primed = tail.state === TIMER_PRIMED || timers.some((e) => e.state === TIMER_PRIMED);
	const speeds = attempt.rows.slice(tail.endRows).map((row) => {
		const f = row.split(',');
		return Math.hypot(Number(f[5]), Number(f[6]));
	});
	const teleported = tail.endSpeed >= TELEPORT_FROM && speeds.length > 0 && speeds[0] < TELEPORT_SPEED;
	let reason = 'stop';
	if (practice || MomentumPlayerAPI.IsInPracticeMode()) reason = 'practice';
	else if (savestate) reason = 'savestate';
	else if (teleported) reason = 'reset';
	else if (primed) reason = 'zone'; // back in the start zone without a teleport
	endAttempt(reason);
}

function startAttempt() {
	const status = MomentumTimerAPI.GetObservedTimerStatus();
	const meta = MomentumTimerAPI.GetObservedRunMetadata();
	const replaying = MomentumReplayAPI.GetReplayState() !== REPLAY_NONE;
	const now = Date.now();
	const id = `${now.toString(36)}${Math.floor(Math.random() * 1296)
		.toString(36)
		.padStart(2, '0')}`;
	attempt = {
		id,
		head: {
			format: FORMAT,
			id,
			started: now,
			map: MapCacheAPI.GetMapName(),
			interval,
			style: status.style,
			track: status.trackId,
			label: replaying || meta ? 'replay' : 'own',
			player: meta ? meta.playerName : null,
			replayFile: meta ? meta.filePath : null,
			practice: MomentumPlayerAPI.IsInPracticeMode(),
			version: MomentumAPI.GetVersionInfo(),
			mouse: mouseOrNull()
		},
		rows: ring.slice(),
		events: [],
		preRows: ring.length,
		gaps: 0,
		runTime: 0,
		tail: null,
		line: { done: replaying || !!meta, seen: 0, at: -1 }
	};
}

function endAttempt(reason: string) {
	if (!attempt) return;
	const status = MomentumTimerAPI.GetObservedTimerStatus();
	const data = JSON.stringify({
		...attempt.head,
		cols: COLS,
		preRows: attempt.preRows,
		postRows: attempt.tail ? attempt.rows.length - attempt.tail.endRows : 0,
		rows: attempt.rows.join(';'),
		events: attempt.events,
		reason,
		runTime: attempt.tail ? attempt.runTime : status.state === TIMER_FINISHED ? status.runTime : attempt.runTime,
		gaps: attempt.gaps,
		ended: Date.now()
	});
	const count = Math.ceil(data.length / CHUNK_CHARS);
	for (let i = 0; i < count; i++) {
		queue.push(`${attempt.id} ${i + 1}/${count} ${data.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)}`);
	}
	queue.push(`${attempt.id} end n=${count} chars=${data.length}`);
	attempt = null;
}

function flush() {
	for (let i = 0; i < CHUNKS_PER_FRAME && queue.length > 0; i++) msg(queue.shift()!);
}

function event(kind: string, fields: Record<string, unknown>) {
	attempt?.events.push({ tick: lastTick, kind, ...fields });
}

function onTimerState() {
	const status = MomentumTimerAPI.GetObservedTimerStatus();
	if (status.state === TIMER_RUNNING && lastState !== TIMER_RUNNING) {
		if (attempt?.tail) finishTail(); // started again inside the tail
		endAttempt('restart'); // only if one was still open, e.g. a missed state change
		startAttempt();
	} else if (lastState === TIMER_RUNNING && status.state !== TIMER_RUNNING) {
		event('timer', { state: status.state, runTime: status.runTime });
		if (status.state === TIMER_FINISHED) endAttempt('finish');
		else startTail(status.state);
	} else if (attempt?.tail) {
		event('timer', { state: status.state, runTime: status.runTime });
	}
	lastState = status.state;
}

function onJump() {
	const s = MomentumMovementAPI.GetLastJumpStats();
	event('jump', {
		n: s.jumpCount,
		takeoff: s.takeoffSpeed,
		delta: s.jumpSpeedDelta,
		takeoffTime: s.takeoffTime,
		sync: s.strafeSync,
		strafes: s.strafeCount,
		gain: s.speedGain,
		ratio: s.yawRatio,
		height: s.heightDelta,
		distance: s.distance,
		eff: s.efficiency
	});
}

// A new observed target or timer must never be glued onto the attempt that was running
function onTargetChange(why: string) {
	endAttempt(why);
	lastState = MomentumTimerAPI.GetObservedTimerStatus().state;
	lastKey = '';
}

// ---------------------------------------------------------------------------------------------
// In-game jump-1 line: shortly after jump 1 lands, a label on the HUD shows landing speed, gain %,
// gain % per strafe and the biggest jump-1 mistake. Own attempts only (tick stats read 0 while
// spectating). The numbers are a port of the viewer's data.js parse/findJumps, drill.js strafeStats
// and checks.js runChecks (jump-1 checks, default thresholds); viewer/check_line.js diffs the two.
// Each line also goes to yaw.log as "SRLINE <id> <json>", which the collector ignores.

const LINE_TAG = 'SRLINE';
const SHOW = { landing: true, gain: true, strafes: true, mistake: true };
const LINE_SECONDS = 4;
// The 5-tick turn average reads 2 rows ahead, so the strafes are split a few rows past the landing
const LINE_DELAY_ROWS = 3;

interface LineState {
	done: boolean; // shown, or not wanted (replays)
	seen: number; // rows already scanned for a landing
	at: number; // row count at which to work the line out, -1 while waiting for a landing
}

// checks.js defaults (CHECKS), jump-1 checks only
const CFG = {
	early: { minTicks: 18 },
	lateFirst: { maxTicks: 3 },
	wide: { ratio: 1.2, skip: 3 },
	narrow: { ratio: 0.4, skip: 3 },
	uneven: { spread: 0.9, skip: 3 },
	wrongKey: { minTicks: 2 },
	noKey: { minTicks: 3 },
	switch: { early: 4, late: 2 }
};
const SWITCH_WINDOW = 8;
const COLLISION = 10;
const B_LEFT = 1 << 7;
const B_RIGHT = 1 << 8;
const B_MOVELEFT = 1 << 9;
const B_MOVERIGHT = 1 << 10;

interface Rows {
	n: number;
	tick: number[];
	gain: number[];
	ideal: number[];
	ratio: number[];
	vz: number[];
	buttons: number[];
	speed: number[];
	gap: number[];
	ground: number[];
	yaws: number[];
	key: number[]; // ideal key: +1 turning left (A), -1 right (D), 0 no clear turn
}

interface Jump {
	s: number;
	e: number;
	pct: number;
	land: number;
}

interface Strafe {
	dir: number;
	i0: number;
	i1: number;
	n: number;
	gap: boolean;
	btn: number;
}

interface Mistake {
	check: string;
	i0: number;
	lost: number;
	text: string;
}

function wrap180(a: number) {
	return ((((a + 180) % 360) + 360) % 360) - 180;
}

function median(vs: number[]) {
	if (!vs.length) return NaN;
	const s = [...vs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pctile(vs: number[], q: number) {
	if (!vs.length) return NaN;
	const s = [...vs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function keyDir(b: number) {
	const a = (b & B_MOVELEFT) !== 0;
	const d = (b & B_MOVERIGHT) !== 0;
	return a && !d ? 1 : d && !a ? -1 : 0;
}

// data.js parse(), own-run columns only
function parseRows(rows: string[]): Rows {
	const n = rows.length;
	const d: Rows = { n, tick: [], gain: [], ideal: [], ratio: [], vz: [], buttons: [], speed: [], gap: [], ground: [], yaws: [], key: [] };
	const yaw: number[] = [];
	const yawd: number[] = [];
	for (let i = 0; i < n; i++) {
		const v = rows[i].split(',');
		d.tick.push(+v[0]);
		d.gain.push(+v[1]);
		d.ideal.push(+v[2]);
		d.ratio.push(+v[3]);
		d.vz.push(+v[7]);
		yaw.push(+v[8]);
		d.buttons.push(+v[10]);
		d.speed.push(Math.hypot(+v[5], +v[6]));
		d.gap.push(i > 0 ? d.tick[i] - d.tick[i - 1] - 1 : 0);
	}
	// Ground: vz exactly 0, except an apex between rising and falling
	for (let i = 0; i < n; i++) {
		const prev = i > 0 ? d.vz[i - 1] : 0;
		const next = i < n - 1 ? d.vz[i + 1] : 0;
		d.ground.push(d.vz[i] !== 0 ? 0 : prev > 0 && next < 0 ? 0 : 1);
		yawd.push(i > 0 && d.gap[i] === 0 ? wrap180(yaw[i] - yaw[i - 1]) : NaN);
	}
	for (let i = 0; i < n; i++) {
		let sum = 0;
		let cnt = 0;
		for (let j = i - 2; j <= i + 2; j++) {
			if (j < 0 || j >= n || Math.abs(d.tick[j] - d.tick[i]) > 2 || !Number.isFinite(yawd[j])) continue;
			sum += yawd[j];
			cnt++;
		}
		d.yaws.push(cnt ? sum / cnt : NaN);
		d.key.push(!d.ground[i] && Math.abs(d.yaws[i]) > 0.3 ? Math.sign(d.yaws[i]) : 0);
	}
	return d;
}

// data.js findJumps(): jump 1 is the air segment in progress at the timer start, else the next one
function findJump1(d: Rows, preRows: number): Jump | null {
	const takeoffs: number[] = [];
	for (let i = 1; i < d.n; i++) if (d.vz[i] > 100 && d.vz[i - 1] <= 0.5) takeoffs.push(i);
	let jumps = takeoffs.map((s, k) => {
		const stop = k + 1 < takeoffs.length ? takeoffs[k + 1] : d.n;
		let e = s + 1;
		while (e < stop && !d.ground[e]) e++;
		let g = 0;
		let id = 0;
		for (let j = s; j < e; j++) {
			if (!Number.isFinite(d.gain[j]) || !Number.isFinite(d.ideal[j])) continue;
			g += d.gain[j];
			id += d.ideal[j];
		}
		return { s, e, pct: id > 0 ? (100 * g) / id : NaN, land: d.speed[e - 1] };
	});
	const p = Math.min(preRows, d.n - 1);
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
	return j1 < 0 ? null : jumps[j1];
}

const strafing = (d: Rows, i: number) => !d.ground[i] && d.speed[i] > 100 && !(d.gain[i] < -COLLISION);
const turnBtn = (d: Rows, i: number) => (d.buttons[i] & (B_LEFT | B_RIGHT)) !== 0;

function strafesOf(d: Rows, s: number, e: number): Strafe[] {
	const out: Strafe[] = [];
	let cur: Strafe | null = null;
	for (let i = s; i < e; i++) {
		const k = d.key[i];
		if (!k) continue;
		if (!cur || cur.dir !== k) {
			cur = { dir: k, i0: i, i1: i, n: 0, gap: false, btn: 0 };
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

function switchesOf(d: Rows, s: number, e: number) {
	const out: { i: number; dir: number }[] = [];
	let last = 0;
	for (let i = Math.max(s - SWITCH_WINDOW, 0); i < e; i++) {
		const k = keyDir(d.buttons[i]);
		if (!k) continue;
		if (last && k !== last) out.push({ i, dir: k });
		last = k;
	}
	return out;
}

function lostOver(d: Rows, i0: number, i1: number) {
	let s = 0;
	for (let i = i0; i <= i1; i++) if (strafing(d, i) && Number.isFinite(d.gain[i]) && Number.isFinite(d.ideal[i])) s += d.ideal[i] - d.gain[i];
	return Math.max(s, 0);
}

function turnStart(d: Rows, s: number, dir: number) {
	let from = s;
	let still = 0;
	for (let i = s - 1; i >= 0 && d.gap[i + 1] === 0; i--) {
		const k = d.key[i];
		if (k === dir) {
			from = i;
			still = 0;
		} else if (k || ++still > 3) break;
	}
	return from;
}

function interior(d: Rows, st: Strafe, skip: number) {
	const out: number[] = [];
	for (let i = st.i0 + skip; i <= st.i1 - skip; i++) if (strafing(d, i) && !turnBtn(d, i) && d.gap[i] === 0) out.push(i);
	return out;
}

function runsOf(d: Rows, from: number, to: number, bad: (i: number) => boolean, min: number) {
	const out: { i0: number; i1: number }[] = [];
	let r: { i0: number; i1: number } | null = null;
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

// drill.js strafeStats(): gain % per strafe over the rows the checks judge
function strafePcts(d: Rows, sts: Strafe[]) {
	return sts.map((st) => {
		let g = 0;
		let id = 0;
		for (let i = st.i0; i <= st.i1; i++) {
			if (strafing(d, i) && Number.isFinite(d.gain[i]) && Number.isFinite(d.ideal[i])) {
				g += d.gain[i];
				id += d.ideal[i];
			}
		}
		return { dir: st.dir, pct: id > 0 ? (100 * g) / id : NaN };
	});
}

const KEY = (dir: number) => (dir > 0 ? 'A' : 'D');

// checks.js runChecks() for jump 1 (weak takeoff needs other attempts, imbalance the whole run)
function jump1Mistakes(d: Rows, j: Jump, e: number, sts: Strafe[]): Mistake[] {
	const s = j.s;
	const out: Mistake[] = [];
	const add = (check: string, i0: number, i1: number, text: string, lost?: number) =>
		out.push({ check, i0, lost: lost === undefined ? lostOver(d, i0, i1) : lost, text });
	const reversals = sts.slice(1).map((st) => st.i0);
	const nearReversal = (i: number) => reversals.some((r) => Math.abs(d.tick[i] - d.tick[r]) <= SWITCH_WINDOW / 2);

	const first = sts[0];
	if (first && sts.length > 1 && !first.gap) {
		const len = d.tick[first.i1] - d.tick[turnStart(d, s, first.dir)] + 1;
		if (len < CFG.early.minTicks) add('early', s, first.i1, `reversed after ${len} ticks`);
	}

	let at = -1;
	for (let i = s; i < e; i++) {
		if (d.key[i] && keyDir(d.buttons[i]) === d.key[i]) {
			at = i;
			break;
		}
	}
	const delay = at < 0 ? NaN : d.tick[at] - d.tick[s];
	if (delay > CFG.lateFirst.maxTicks) add('lateFirst', s, at - 1, `first key ${delay} ticks late`);

	sts.forEach((st, k) => {
		if (st.gap || st.n < 8) return;
		const name = `${KEY(st.dir)}${k + 1}`;
		const inW = interior(d, st, CFG.wide.skip).filter((i) => Number.isFinite(d.ratio[i]));
		const mW = median(inW.map((i) => d.ratio[i]));
		if (inW.length >= 4 && mW > CFG.wide.ratio) add('wide', st.i0, st.i1, `${name} too wide (${mW.toFixed(2)})`, lostOver(d, inW[0], inW[inW.length - 1]));
		const inN = interior(d, st, CFG.narrow.skip).filter((i) => Number.isFinite(d.ratio[i]));
		const mN = median(inN.map((i) => d.ratio[i]));
		if (inN.length >= 4 && mN < CFG.narrow.ratio) add('narrow', st.i0, st.i1, `${name} too narrow (${mN.toFixed(2)})`, lostOver(d, inN[0], inN[inN.length - 1]));
		const inU = interior(d, st, CFG.uneven.skip)
			.map((i) => Math.abs(d.yaws[i]))
			.filter(Number.isFinite);
		const mid = median(inU);
		const spread = mid > 0 ? (pctile(inU, 0.9) - pctile(inU, 0.1)) / mid : NaN;
		if (inU.length >= 6 && spread > CFG.uneven.spread) add('uneven', st.i0, st.i1, `${name} uneven turn`);
	});

	const judged = (i: number) => d.key[i] !== 0 && !turnBtn(d, i) && !nearReversal(i);
	for (const r of runsOf(d, s, e, (i) => judged(i) && keyDir(d.buttons[i]) === -d.key[i], CFG.wrongKey.minTicks))
		add('wrongKey', r.i0, r.i1, `wrong key ${r.i1 - r.i0 + 1} ticks`);
	for (const r of runsOf(d, s, e, (i) => judged(i) && !(d.buttons[i] & (B_MOVELEFT | B_MOVERIGHT)), CFG.noKey.minTicks))
		add('noKey', r.i0, r.i1, `no key ${r.i1 - r.i0 + 1} ticks`);

	const sw = switchesOf(d, s, e);
	for (let k = 1; k < sts.length; k++) {
		const st = sts[k];
		if (st.gap || sts[k - 1].gap) continue;
		let best: { off: number; i: number } | null = null;
		for (const w of sw) {
			if (w.dir !== st.dir) continue;
			const off = d.tick[w.i] - d.tick[st.i0];
			if (Math.abs(off) <= SWITCH_WINDOW && (!best || Math.abs(off + 1) < Math.abs(best.off + 1))) best = { off, i: w.i };
		}
		if (!best) continue;
		const lo = Math.min(best.i, st.i0);
		const hi = Math.max(best.i, st.i0);
		if (best.off <= -CFG.switch.early) add('switch', lo, hi, `${KEY(st.dir)} switch ${-best.off} ticks early`);
		else if (best.off >= CFG.switch.late) add('switch', lo, hi, `${KEY(st.dir)} switch ${best.off} ticks late`);
	}

	out.sort((a, b) => b.lost - a.lost);
	return out;
}

let linePanel: Panel | null = null;
let lineToken = 0;

const SHADOW = 'text-shadow: 0px 1px 4px 2px rgba(0, 0, 0, 0.9);';

// drill.js gainColor(): red at 60 % and under, green at 95 % and over
function gainColor(p: number) {
	if (!Number.isFinite(p)) return 'rgb(140,140,150)';
	const t = Math.max(0, Math.min(1, (p - 60) / 35));
	const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
	return `rgb(${mix(0xff, 0x7b)},${mix(0x5c, 0xd8)},${mix(0x5c, 0x8f)})`;
}

// Up to 3 rows under the screen centre: head (landing, gain), one coloured box per strafe, mistake
function showLine(head: string, strafes: { dir: number; pct: number }[], mistake: string) {
	if (!linePanel || !linePanel.IsValid()) {
		const ctx = $.GetContextPanel();
		const root = ctx.GetParent() ?? ctx;
		root.FindChildTraverse('StrafeReviewLine')?.DeleteAsync(0);
		// Top middle of the screen (Panorama px are 1080p units)
		linePanel = $.CreatePanel('Panel', root, 'StrafeReviewLine', {
			style: 'horizontal-align: center; vertical-align: top; margin-top: 20px; flow-children: down;'
		});
	}
	const panel = linePanel;
	panel.RemoveAndDeleteChildren();
	const text = (parent: Panel, t: string, size: number) =>
		$.CreatePanel('Label', parent, '', {
			text: t,
			style: `horizontal-align: center; font-size: ${size}px; font-weight: bold; color: #ffffff; ${SHADOW}`
		});
	if (head) text(panel, head, 22);
	if (strafes.length) {
		const row = $.CreatePanel('Panel', panel, '', { style: 'horizontal-align: center; flow-children: right; margin: 4px 0px;' });
		for (const st of strafes) {
			$.CreatePanel('Label', row, '', {
				text: `${KEY(st.dir)} ${Number.isFinite(st.pct) ? st.pct.toFixed(1) : '-'} %`,
				style: `font-size: 20px; font-weight: bold; color: #111111; background-color: ${gainColor(st.pct)};
					padding: 2px 8px; margin: 0px 3px; border-radius: 4px;`
			});
		}
	}
	if (mistake) text(panel, mistake, 19);
	panel.visible = true;
	const token = ++lineToken;
	$.Schedule(LINE_SECONDS, () => {
		if (token === lineToken && linePanel?.IsValid()) linePanel.visible = false;
	});
}

function workOutLine(a: Attempt) {
	const d = parseRows(a.rows);
	const endIdx = a.tail ? a.tail.endRows - 1 : d.n - 1;
	const j = findJump1(d, a.preRows);
	// not landed yet: the landing seen was a hop before jump 1, or the run ended in the air
	if (!j || j.e >= d.n || j.e - 1 > endIdx) return false;
	const e = Math.min(j.e, endIdx + 1);
	const sts = strafesOf(d, j.s, e);
	const pcts = strafePcts(d, sts);
	const mistakes = jump1Mistakes(d, j, e, sts);
	const top = mistakes[0];
	const head = [SHOW.landing ? `J1 ${j.land.toFixed(0)} u/s` : '', SHOW.gain ? `${j.pct.toFixed(2)} %` : ''].filter(Boolean).join('  ·  ');
	const mistake = SHOW.mistake && top ? `${top.text} (-${top.lost.toFixed(1)} u/s)` : '';
	if (head || (SHOW.strafes && pcts.length) || mistake) showLine(head, SHOW.strafes ? pcts : [], mistake);
	$.Msg(
		`${LINE_TAG} ${a.id} ${JSON.stringify({
			s: j.s,
			e: j.e,
			land: +j.land.toFixed(3),
			pct: +j.pct.toFixed(3),
			strafes: pcts.map((p) => [p.dir, +p.pct.toFixed(3)]),
			mistakes: mistakes.map((m) => [m.check, m.i0, +m.lost.toFixed(3)])
		})}`
	);
	return true;
}

// Scans new rows for a landing (vz from falling to exactly 0, or a takeoff); works the line out a few rows later
function lineStep() {
	const a = attempt;
	if (!a || a.line.done) return;
	const st = a.line;
	for (; st.seen < a.rows.length; st.seen++) {
		if (st.seen === 0 || st.at >= 0) continue;
		const vz = Number(a.rows[st.seen].split(',')[7]);
		const prev = Number(a.rows[st.seen - 1].split(',')[7]);
		// A missed landing tick goes straight from falling to the next takeoff, which also ends a jump in findJumps
		if ((vz === 0 && prev < 0) || (vz > 100 && prev <= 0.5)) st.at = st.seen + 1 + LINE_DELAY_ROWS;
	}
	if (st.at >= 0 && a.rows.length >= st.at) {
		st.done = workOutLine(a); // false: keep scanning for the next landing
		st.at = -1;
	}
}

function loop() {
	guard('sample', sample);
	guard('line', lineStep);
	if (attempt?.tail && Date.now() > attempt.tail.untilMs) guard('tail', finishTail);
	guard('flush', flush);
	$.Schedule(0, loop);
}

$.Schedule(0, loop);
$.RegisterForUnhandledEvent('OnObservedTimerStateChange', () => guard('timer', onTimerState));
$.RegisterForUnhandledEvent('OnMomentumPlayerPracticeModeStateChange', (on) =>
	guard('practice', () => event('practice', { on }))
);
$.RegisterForUnhandledEvent('OnSaveStateUpdate', (count, current, usingMenu) =>
	guard('savestate', () => event('savestate', { count, current, usingMenu }))
);
$.RegisterForUnhandledEvent('OnJumpStarted', () => guard('jump', onJump));
$.RegisterForUnhandledEvent('ObserverTargetChanged', () => guard('target', () => onTargetChange('target')));
$.RegisterForUnhandledEvent('OnObservedTimerReplaced', () => guard('replaced', () => onTargetChange('replaced')));
$.RegisterForUnhandledEvent('LevelInitPostEntity', () => guard('level', onLevelInit));

guard('mouse', () => msg(`mouse ${JSON.stringify(mouse())}`));
msg(`load format=${FORMAT} interval=${interval}`);
