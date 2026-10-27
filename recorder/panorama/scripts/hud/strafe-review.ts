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
			version: MomentumAPI.GetVersionInfo()
		},
		rows: ring.slice(),
		events: [],
		preRows: ring.length,
		gaps: 0,
		runTime: 0,
		tail: null
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

function loop() {
	guard('sample', sample);
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

msg(`load format=${FORMAT} interval=${interval}`);
