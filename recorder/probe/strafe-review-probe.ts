// Strafe Review first-step probe. Loaded next to timer.ts (see layout/hud/timer.xml).
// Answers three questions, all through [panorama] lines tagged SRPROBE in yaw.log:
//   1. Does a script in momentum/custom/ load?          -> "load" + "hb" heartbeat lines
//   2. Do long $.Msg lines reach yaw.log whole?         -> "len" lines with an end sentinel
//   3. Does dumping a whole run hitch on instant reset? -> "dump" lines with the time taken
// Reads only; sends no inputs.

const TAG = 'SRPROBE';
const VERSION = 5;

// TimerState from common/timer.ts (copied so this file has no imports)
const TIMER_RUNNING = 2;

const LENGTH_TESTS = [256, 1024, 2048, 4096, 8192, 16384];
const CHUNK_CHARS = 1000; // kept under the longest line length known to survive (89 seen so far, 1000 is a guess)
const SYNTHETIC_TICKS = 3 * 60 * 100; // 3 minutes at 100 tick, the worst case for check 3
const HEARTBEAT_MS = 5000;

let frames = 0;
// Calls per frame source; v1 got none through HudProcessInput on the timer's own panel
const sources: Record<string, number> = { cp: 0, child: 0, think: 0, schedule: 0 };
let ticks = 0;
let gaps = 0;
let dupes = 0; // frames that landed on an already-seen tick
let maxFrac = 0; // largest distance of game time from a whole tick, to see if time is tick-aligned
let hbTime = -1; // game time at the last heartbeat
let hbWall = 0; // Date.now() at the last heartbeat
// v2 showed game time is interpolated per frame, so rounding it gives false gaps.
// v3 also counts ticks by the timer's own tickstamp (only moves while the timer runs).
let lastStamp = -1;
let stampTicks = 0;
let stampGaps = 0;
let hbStampTicks = 0;
let hbStampGaps = 0;
let hbTicks = 0;
let hbGaps = 0;
let lastTickNo = -1;
const reported = new Set<string>();
let lastHeartbeat = 0;
let lastState = -1;
let attempt = 0;
let lengthTestDone = false;
let buffer: string[] = [];

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

function heartbeat() {
	const now = Date.now();
	if (now - lastHeartbeat < HEARTBEAT_MS) return;
	lastHeartbeat = now;
	const time = MomentumMovementAPI.GetCurrentTime();
	// expected = ticks the game clock moved since the last hb; should equal dticks + dgaps
	const expected = hbTime < 0 ? 0 : Math.round((time - hbTime) / MomentumMovementAPI.GetTickInterval());
	const status = MomentumTimerAPI.GetObservedTimerStatus();
	const state = status.state;
	msg(
		`hb4 wallms=${hbWall ? now - hbWall : 0} interval=${MomentumMovementAPI.GetTickInterval()} ` +
			`runticks=${stampTicks - hbStampTicks} rungaps=${stampGaps - hbStampGaps} runfrac=${r(runFracMax, 4)} ` +
			`statchanges=${statsChanges - hbStatsChanges}`
	);
	msg(`phase ${phaseBins.join(',')}`);
	phaseBins = new Array<number>(10).fill(0);
	hbStatsChanges = statsChanges;
	runFracMax = 0;
	hbWall = now;
	hbStampTicks = stampTicks;
	hbStampGaps = stampGaps;
	msg(
		`hb frames=${frames} ticks=${ticks} gaps=${gaps} dupes=${dupes} expected=${expected} ` +
			`src=${Object.entries(sources).map(([k, v]) => `${k}:${v}`).join('/')} dticks=${ticks - hbTicks} dgaps=${gaps - hbGaps} maxfrac=${r(maxFrac, 4)} state=${state} buf=${buffer.length}`
	);
	hbTime = time;
	hbTicks = ticks;
	hbGaps = gaps;
	maxFrac = 0;
}

function onFrame(source: string) {
	sources[source]++;
	frames++;
	guard('heartbeat', heartbeat);
	guard('stamp', countStamp);
	guard('frame', recordTick);
}

// v3: runTimeTickstamp is undefined at runtime. v4 tries two other tick signals:
// runTime rounded to ticks (while running), and a change in the per-tick stats + velocity.
let lastStatsKey = '';
let statsChanges = 0;
let runFracMax = 0;
function countStamp() {
	const s = MomentumMovementAPI.GetLastTickStats();
	const v = MomentumPlayerAPI.GetVelocity();
	const key = `${s.speedGain},${s.idealGain},${s.yawRatio},${s.strafeRight},${v.x},${v.y},${v.z}`;
	if (key !== lastStatsKey) {
		statsChanges++;
		lastStatsKey = key;
		// v5: where inside a tick does game time sit on the frame a new tick shows up?
		// A tight cluster means floor(time / interval - phase) gives exact tick numbers.
		const exact = MomentumMovementAPI.GetCurrentTime() / MomentumMovementAPI.GetTickInterval();
		phaseBins[Math.min(9, Math.floor((exact - Math.floor(exact)) * 10))]++;
	}

	const status = MomentumTimerAPI.GetObservedTimerStatus();
	if (status.state !== TIMER_RUNNING) {
		lastStamp = -1;
		return;
	}
	const exact = status.runTime / MomentumMovementAPI.GetTickInterval();
	const stamp = Math.round(exact);
	runFracMax = Math.max(runFracMax, Math.abs(exact - stamp));
	if (stamp === lastStamp) return;
	if (lastStamp >= 0) {
		stampTicks++;
		if (stamp > lastStamp + 1) stampGaps += stamp - lastStamp - 1;
	}
	lastStamp = stamp;
}

let hbStatsChanges = 0;
let phaseBins = new Array<number>(10).fill(0);

function recordTick() {
	const time = MomentumMovementAPI.GetCurrentTime();
	const interval = MomentumMovementAPI.GetTickInterval();
	const exact = time / interval;
	const tickNo = Math.round(exact);
	maxFrac = Math.max(maxFrac, Math.abs(exact - tickNo));
	if (tickNo === lastTickNo) {
		dupes++;
		return;
	}
	ticks++;
	if (lastTickNo >= 0 && tickNo > lastTickNo + 1) gaps += tickNo - lastTickNo - 1;
	lastTickNo = tickNo;

	// Same fields the real recorder will keep, so the dump size and cost are realistic
	const stats = MomentumMovementAPI.GetLastTickStats();
	const vel = MomentumPlayerAPI.GetVelocity();
	const ang = MomentumPlayerAPI.GetAngles();
	const move = MomentumMovementAPI.GetMoveHudData();
	const buttons = MomentumInputAPI.GetButtons().physicalButtons;
	buffer.push(
		[
			tickNo,
			r(stats.speedGain, 3),
			r(stats.idealGain, 3),
			r(stats.yawRatio, 3),
			stats.strafeRight,
			r(vel.x, 1),
			r(vel.y, 1),
			r(vel.z, 1),
			r(ang.y, 2),
			r(ang.x, 2),
			buttons,
			move.moveStatus
		].join(',')
	);
	// Outside a run, keep only the last 2 s at 100 tick
	if (lastState !== TIMER_RUNNING && buffer.length > 200) buffer.shift();
}

function onJump() {
	const s = MomentumMovementAPI.GetLastJumpStats();
	const buttons = MomentumInputAPI.GetButtons().physicalButtons;
	msg(
		`jump n=${s.jumpCount} takeoff=${r(s.takeoffSpeed, 1)} gain=${r(s.speedGain, 3)} sync=${r(s.strafeSync, 3)} ` +
			`yawratio=${r(s.yawRatio, 3)} strafes=${s.strafeCount} eff=${r(s.efficiency, 3)} buttons=${buttons}`
	);
}

function dump(label: string, rows: string[]) {
	const start = Date.now();
	const data = rows.join(';');
	const count = Math.ceil(data.length / CHUNK_CHARS);
	for (let i = 0; i < count; i++) {
		msg(`chunk ${label} ${i + 1}/${count} ${data.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)}`);
	}
	msg(`dump ${label} rows=${rows.length} chars=${data.length} chunks=${count} ms=${Date.now() - start}`);
}

function lengthTest() {
	// Each line ends with "END<n>"; a cut line in yaw.log is missing that sentinel
	for (const n of LENGTH_TESTS) {
		const head = `len ${n} `;
		const tail = ` END${n}`;
		const fill = 'x'.repeat(Math.max(0, n - head.length - tail.length - TAG.length - 1));
		msg(head + fill + tail);
	}
}

function syntheticDump() {
	const row = '12345,0.123,0.456,1.002,1,-512.3,301.7,-12.0,123.45,-3.21,1544,0';
	dump('synthetic', Array.from({ length: SYNTHETIC_TICKS }, () => row));
}

function onTimerState() {
	const status = MomentumTimerAPI.GetObservedTimerStatus();
	msg(`timer state=${status.state} runtime=${r(status.runTime, 3)} style=${status.style}`);

	if (status.state === TIMER_RUNNING && lastState !== TIMER_RUNNING) {
		attempt++;
		buffer = []; // the real recorder keeps the last 2 s before the start; the probe does not
	} else if (lastState === TIMER_RUNNING && status.state !== TIMER_RUNNING) {
		dump(`attempt${attempt}`, buffer);
		buffer = [];
		if (!lengthTestDone) {
			lengthTestDone = true;
			lengthTest();
		} else if (attempt === 3) {
			syntheticDump();
		}
	}
	lastState = status.state;
}

// Several frame sources at once; ticks are deduplicated, so extra calls only count as dupes
$.RegisterEventHandler('HudProcessInput', $.GetContextPanel(), () => onFrame('cp'));
const host = $.CreatePanel('Panel', $.GetContextPanel(), 'StrafeReviewProbe');
$.RegisterEventHandler('HudProcessInput', host, () => onFrame('child'));
$.RegisterEventHandler('HudThink', host, () => onFrame('think'));
function scheduleLoop() {
	onFrame('schedule');
	$.Schedule(0, scheduleLoop);
}
$.Schedule(0, scheduleLoop);
$.RegisterForUnhandledEvent('OnJumpStarted', () => guard('jump', onJump));
$.RegisterForUnhandledEvent('OnObservedTimerStateChange', () => guard('timer', onTimerState));

msg(`load v${VERSION} interval=${MomentumMovementAPI.GetTickInterval()}`);
guard('keys', () => {
	msg(`keys timer=${Object.keys(MomentumTimerAPI.GetObservedTimerStatus()).join(',')}`);
	msg(`keys tick=${Object.keys(MomentumMovementAPI.GetLastTickStats()).join(',')}`);
	msg(`keys move=${Object.keys(MomentumMovementAPI.GetMoveHudData()).join(',')}`);
	msg(`keys api=${Object.keys(MomentumMovementAPI).join(',')} timerapi=${Object.keys(MomentumTimerAPI).join(',')}`);
});
