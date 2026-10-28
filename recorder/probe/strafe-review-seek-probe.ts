// Strafe Review seek probe (2026-10-28). Loaded next to timer.ts, only for this test.
// Question: can the recorder fill ticks it missed during replay playback by seeking the paused replay?
// When a replay is paused (up to 3 times, each at a new tick) it steps 5 ticks back, jumps 40 back with
// GoTo, steps 3 forward (v2: 3 back, GoTo 20 back, 2 forward, 40 frames each), then returns to where it was paused. After each seek it logs what the APIs read
// for 4 frames, as [panorama] SRSEEK lines in yaw.log. Events that fire meanwhile are logged too.
// The recorder records the same replay while it plays, so viewer/../check_seek.py compares a seek's
// values at replay tick T with the playback rows at rtick T (and T+6: angles play back late).
// Sends replay controls (pause state is kept); nothing else.

const TAG = 'SRSEEK';
const VERSION = 2;
const PAUSED = 2;
const FRAMES_PER_STEP = 40; // v2: does yaw settle after a seek, and on what?
const MAX_RUNS = 3;

type Step = { name: string; act: () => void };

let runs = 0;
let lastPausedAt = -1;
let steps: Step[] = [];
let stepIdx = -1;
let frame = 0;
let busy = false;

function msg(text: string) {
	$.Msg(`${TAG} ${text}`);
}

function r(v: number, d: number) {
	return Number(v.toFixed(d));
}

function snap(name: string, f: number) {
	const p = MomentumReplayAPI.GetReplayProgress();
	const vel = MomentumPlayerAPI.GetVelocity();
	const ang = MomentumPlayerAPI.GetAngles();
	const move = MomentumMovementAPI.GetMoveHudData();
	msg(
		`snap ${JSON.stringify({
			step: name,
			f,
			state: MomentumReplayAPI.GetReplayState(),
			cur: p.curtick,
			total: p.totalticks,
			curtime: r(p.curtime, 4),
			start: r(p.starttime, 4),
			end: r(p.endtime, 4),
			game: r(MomentumMovementAPI.GetCurrentTime(), 4),
			vx: r(vel.x, 2),
			vy: r(vel.y, 2),
			vz: r(vel.z, 2),
			yaw: r(ang.y, 3),
			pitch: r(ang.x, 3),
			btn: MomentumInputAPI.GetButtons().physicalButtons,
			duck: MomentumPlayerAPI.IsDucking() ? 1 : 0,
			wx: r(move.wishVel.x, 2),
			wy: r(move.wishVel.y, 2),
			timer: MomentumTimerAPI.GetObservedTimerStatus().state
		})}`
	);
}

function plan(c0: number, total: number): Step[] {
	const s: Step[] = [{ name: 'start', act: () => {} }];
	for (let i = 1; i <= 3; i++) s.push({ name: `prev${i}`, act: () => MomentumReplayAPI.GoToPreviousTick() });
	const t = Math.max(0, c0 - 20);
	s.push({ name: `goto${t}`, act: () => MomentumReplayAPI.GoTo(t / total) });
	for (let i = 1; i <= 2; i++) s.push({ name: `next${i}`, act: () => MomentumReplayAPI.GoToNextTick() });
	s.push({ name: `back${c0}`, act: () => MomentumReplayAPI.GoTo(c0 / total) });
	return s;
}

// After the GoTo back, step to the exact paused tick if GoTo landed next to it
function fixBack(c0: number) {
	const cur = MomentumReplayAPI.GetReplayProgress().curtick;
	if (cur < c0) MomentumReplayAPI.GoToNextTick();
	else if (cur > c0) MomentumReplayAPI.GoToPreviousTick();
	return cur;
}

let target = -1;
let fixes = 0;

function loop() {
	try {
		if (busy) {
			const st = steps[stepIdx];
			snap(st.name, frame);
			frame++;
			if (frame >= FRAMES_PER_STEP) {
				stepIdx++;
				frame = 0;
				if (stepIdx < steps.length) steps[stepIdx].act();
				else if (fixes < 10 && MomentumReplayAPI.GetReplayProgress().curtick !== target) {
					stepIdx = steps.length - 1;
					fixes++;
					msg(`fix ${fixBack(target)} -> ${target}`);
				} else {
					busy = false;
					msg(`done run=${runs} cur=${MomentumReplayAPI.GetReplayProgress().curtick} target=${target} state=${MomentumReplayAPI.GetReplayState()}`);
				}
			}
		} else if (runs < MAX_RUNS && MomentumReplayAPI.GetReplayState() === PAUSED) {
			const p = MomentumReplayAPI.GetReplayProgress();
			if (p.curtick !== lastPausedAt && p.curtick > 45) {
				lastPausedAt = p.curtick;
				runs++;
				target = p.curtick;
				fixes = 0;
				steps = plan(p.curtick, p.totalticks);
				stepIdx = 0;
				frame = 0;
				busy = true;
				msg(`run ${runs} paused at ${p.curtick} of ${p.totalticks}`);
			}
		}
	} catch (e) {
		msg(`err ${e}`);
		busy = false;
	}
	$.Schedule(0, loop);
}

const ev = (name: string) => () => {
	if (busy) msg(`event ${name} step=${steps[stepIdx]?.name} f=${frame}`);
};
$.RegisterForUnhandledEvent('OnObservedTimerStateChange', ev('timer'));
$.RegisterForUnhandledEvent('OnJumpStarted', ev('jump'));
$.RegisterForUnhandledEvent('OnObservedTimerReplaced', ev('replaced'));
$.RegisterForUnhandledEvent('ObserverTargetChanged', ev('target'));

msg(`load version=${VERSION}`);
$.Schedule(0, loop);
