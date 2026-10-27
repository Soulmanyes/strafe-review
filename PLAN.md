# Strafe Review: plan

Status: probe done (`recorder/probe/`, results below). Recorder v1 written and play-tested (`recorder/panorama/scripts/hud/strafe-review.ts`, checked by `recorder/check_recorder.py`). Collector v1 written (`collector/`, see "Collector v1" below). Viewer v1 (main view) written (`viewer/`, see "Viewer v1" below). Next: the mistake checks.

## Goal

Review strafing per jump after a Momentum Mod run ends, failed or finished. The main problem to solve is bad gain on the first jump (from leaving the start zone to the first landing), but the whole run should be reviewable.

Momentum's built-in JSS/gain HUD is hard to read mid-run and has no history once the run is over. This tool records every tick and shows it afterwards outside the game, in a local web page, at any resolution and on any monitor.

Scope: Momentum Mod only for now. CS:S has no Panorama HUD, so a CS:S version would need input-based simulation instead (see "Later").

## Architecture

1. **Recorder (inside Momentum).** An invisible custom Panorama HUD script, loaded from `momentum/custom/<folder>/`.
   - It buffers every tick of the attempt. When the attempt ends, it writes the run out in compact chunks with `$.Msg`.
   - Panorama output ends up in the console log (`con_logfile`, already used by Source Yaw as `yaw.log`).
   - Chunked output avoids printing to the console every tick, which could stutter.
2. **Collector.** Tails `yaw.log`, puts the chunks back together, and saves each attempt to disk as a compressed file. It lives in this private repo. Source Yaw doesn't have to be involved; for now it leans on Source Yaw only because that is the simplest way to make it work (Source Yaw's `yaws.cfg` turns on `con_logfile`, and the launch option chains `sourceyaw-run`). Moving into Source Yaw later is an option, not a plan (owner, 2026-10-27).
3. **Viewer (local web page).** Served on localhost by `viewer/server.py` in this private repo (like the collector, it stays separate from Source Yaw). It reads the saved attempts and shows the graphs.

A HUD that only reads and displays data is normal in Momentum; HUD customisation is common there. The recorder never sends inputs.

## Facts checked (2026-10-25)

- **Custom files load first.** `gameinfo.txt` mounts `momentum/custom/*` first as `game+mod`, so files there override the game's own.
- **Scripts compile at runtime.** `panorama.so` contains the TypeScript transpiler, so `.ts` HUD scripts are compiled when the game loads them.
- **Where HUD panels are defined.** HUD children are listed in `panorama/layout/hud/hud.xml` and registered in `panorama/scripts/util/panel-registration.ts`. The lightest hook is probably overriding one small existing HUD script, not the whole of `hud.xml`, which would hide future upstream changes to that file.
- **Probe v1 results (2026-10-27).**
  - A script in `custom/` loads, and `$.Msg` lines reach `yaw.log` as `[panorama] <text>`.
  - Each `$.Msg` is cut at 2047 characters and loses its newline, so the next message gets glued onto it. Keep chunks well under that (1000 is used).
  - Dumping 1.17 MB (a 3-minute 100-tick run) as 1170 lines took 20 ms, with no stutter felt on an instant reset.
  - `HudProcessInput` registered on the timer's own panel never fired for the probe (timer.ts already handles it there).
- **Probe v2 results (2026-10-27).**
  - `HudProcessInput` and `HudThink` on a child panel never fired either. Only a `$.Schedule(0, …)` loop runs every frame (about 254 calls a second here).
  - `GetTickInterval()` reads 1/64 in the main menu and changes on map load (bhop_glacial: 100 tick). Read it at attempt start.
  - `GetCurrentTime()` is interpolated per frame, not tick-aligned. Rounding it to ticks gives false gaps (6–20 per 5 s at 254 fps). v3 compares this against the timer's `runTimeTickstamp`.
  - On reset the timer goes 1 (PRIMED) to 2 (RUNNING) and back to 1. `jumpCount` counts the jump in the start zone, so the first jump after leaving the zone can show as jump 2.
- **Probe v3–v5 results (2026-10-27).**
  - `panorama_reload` in the console reloads the probe without a game restart, while on a map.
  - The timer status object has no tick counter at runtime: `runTimeTickstamp` is `undefined` (keys: `trackId, state, runTime, majorNum, minorNum, style, segmentsCount, segmentCheckpointsCount`). Rounding `runTime` to ticks gives 50–200 false gaps per 5 s.
  - A change in `GetLastTickStats()` or the velocity counts 492–500 ticks per 5 s at 100 tick while moving, so it marks ticks reliably.
  - On the frame a new tick shows up, game time sits 0–0.4 of a tick past a whole tick in about 90% of cases, at about 254 fps. So the tick boundary is at the whole tick, and `floor` numbers ticks correctly.
- **Chosen hook (2026-10-27).** The recorder shadows `panorama/layout/hud/timer.xml` (16 lines) with a copy that adds one more `<include type="module">`. The timer is always shown, while jump-stats is bhop-only in the HUD customizer. `recorder/install.sh` warns when the game's own `timer.xml` has changed since the copy.
- **Per-tick data:**
  - `MomentumMovementAPI.GetLastTickStats()` gives `strafeRight`, `speedGain`, `idealGain` and `yawRatio`.
  - `MomentumPlayerAPI.GetVelocity()` and `GetAngles()` give velocity and view angles.
  - `MomentumMovementAPI.GetMoveHudData()` gives `wishVel`, `moveStatus` (air/walk) and more.
  - `MomentumMovementAPI.GetTickInterval()` and `GetCurrentTime()` give tick timing.
- **Per-jump data:** `MomentumMovementAPI.GetLastJumpStats()` gives takeoff speed, speed delta, sync, gain, strafe count, yaw ratio, efficiency, distance and height delta.
- **Keys.** `MomentumInputAPI.GetButtons().physicalButtons` is a bitmask (see `panorama/scripts/common/buttons.ts`):
  - `JUMP` 1<<1, `FORWARD` 1<<3, `MOVELEFT` 1<<9, `MOVERIGHT` 1<<10
  - `LEFT` 1<<7 and `RIGHT` 1<<8: the `+left`/`+right` turn buttons
- **Events:**
  - `OnJumpStarted`
  - `OnObservedTimerStateChange`, for timer start, stop and reset
  - `EndOfRun_Show`
- **Drawing (if ever needed in game).** `UICanvas` has `DrawLinePoints`, `DrawPoly` and `DrawShadedPoly`. There is also `components/graphs/line-graph.ts`.
- **Spectating.** The player API reports "the player or spec target". So a replay played in game can probably be recorded like an attempt. This is untested.
- **Replays on disk.**
  - Own replays live in `momtv/local/<map>/*.mtv`, but only for finished runs or stages.
  - Downloaded online replays live in `momtv/online/<id>/*.mtv`.
  - Both start with the header `MMTV`, version 2.
- **No position API** was found in the HUD scripts. The path is built up from velocity times the tick interval instead.

## Recording rules

- **Attempt boundaries.** An attempt starts when the timer starts (leaving the start zone). It ends on finish, reset, teleport back to the start, or a fail.
- **Prestrafe.** Each attempt also keeps the last 2 seconds before the timer starts, so the prestrafe and takeoff are visible.
- **Frames vs ticks.** HUD scripts run once per frame, not once per tick. Settled by probes v2–v5:
  - The recorder runs from a `$.Schedule(0, …)` loop. `HudProcessInput` and `HudThink` never reach it.
  - A new tick is seen when `GetLastTickStats()` or the velocity changes, or when `floor(GetCurrentTime() / interval)` moves on while standing still.
  - The tick number is `floor(GetCurrentTime() / interval)`, raised to last + 1 if a change shows up inside the same number. Do not use `Math.round`: game time is interpolated, and rounding gives false gaps.
  - Ticks missed because fps dropped below the tickrate are stored as gaps, never filled in.
- **Recorder v1 (2026-10-27).**
  - A 2-second ring buffer runs all the time (`ceil(2 / interval)` rows, re-sized on `LevelInitPostEntity`). When the timer starts, the attempt copies the ring and keeps appending; `preRows` marks where the run starts.
  - Jump 1 takes off inside the start zone, before the timer starts. The recorder does not define jumps: `move` (air/walk) in every row and raw `OnJumpStarted` + `GetLastJumpStats()` events are stored, and the viewer finds jump 1 as the air segment around the start.
  - End reasons (changed 2026-10-27 after a play test): a run that stops without finishing keeps recording for 0.5 s (`postRows` rows after the end), then the reason is judged:
    - `practice`: an `OnMomentumPlayerPracticeModeStateChange` (on) event. `IsInPracticeMode()` still read false 0.5 s after practice mode stopped a run.
      Tested with `mom_practice` mid-run (`mom_practice_warning_enable 1`): the first command only warns (a sound), yet the timer already stops as DISABLED. Practice mode turns on with the second command, more than 0.5 s later, so such runs end as `stop`. Accepted: the owner does not use practice mode, and the stored tail lets the viewer re-judge later.
    - `savestate`: a savestate event on the end tick or the tick before. Loading a savestate (the owner's practice routine, savestate menu) stops the timer as DISABLED; the game's real practice mode was not used.
    - `reset`: horizontal speed falls from 30+ to under 5 on the first tick after the end (a teleport). `mom_restart_stage` (the owner's `r`) ends the timer as DISABLED then PRIMED; 361 to 0 in one tick.
    - `zone`: the timer went PRIMED without a teleport: bhopped back into the start zone (speed bled off 42, 39, 21, 3, 0).
    - `stop`: anything else that ends as DISABLED.
    - Savestate updates are stored as `savestate` events, practice changes as `practice` events.
  - Other end reasons: `finish` (RUNNING to FINISHED), `target` (`ObserverTargetChanged`), `replaced` (`OnObservedTimerReplaced`), `level` (map change), `restart` (a start while one was still open).
  - Labels: `replay` when `GetReplayState()` is not NONE or `GetObservedRunMetadata()` is set (with player name and replay file), else `own`. `practice` is stored too.
- **Wire format 1.** Every line is `[panorama] SRREC <id> ...`:
  - `<id> <i>/<n> <text>`: chunk i of n, at most 900 characters. The chunks joined in order are one JSON object.
  - `<id> end n=<n> chars=<c>`: last line; an attempt with missing chunks is dropped.
  - JSON fields: `format, id, started, map, interval, style, track, label, player, replayFile, practice, version, cols, preRows, rows, events, reason, runTime, gaps, ended`.
  - `rows` is rows joined by `;`, each row the comma-separated values named in `cols`: `tick, gain, ideal, ratio, right, vx, vy, vz, yaw, pitch, buttons, move, duck, rtick`. New columns are added at the end and named in `cols`, so old files still read.
  - `id` is `Date.now()` in base 36 plus 2 random characters, so it never repeats across `panorama_reload`.
  - Chunks go out at most 200 per frame, so a long run never hitches.
  - A map change in the middle of an attempt dumps what was recorded (`level`).
- **Open until the first recorder play test:**
  - Does `GetLastTickStats()` follow the spec target? No: `gain`, `ideal` and `ratio` read 0 on every row of a replay (checked 2026-10-27). The viewer rebuilds them from speed (see "Viewer v1").
  - What does a stage teleport do mid-run?
  - Self-checks in `check_recorder.py`: on a finish, run rows + gaps must match `round(runTime / interval)` within 1; during a replay, `tick - rtick` must stay constant.
- **Recorder v1 play test (2026-10-27, bhop_ambience, 100 tick).** 6 attempts, none broken.
  - Finish: run rows + gaps = 2086, `round(runTime / interval)` = 2086. Tick numbering is exact. 10 gaps in 20.9 s.
  - Replay (player E): `tick - rtick` stayed constant in 1269 of 1270 rows. The replay ended as `replaced` when it was stopped.
  - Keys while spectating a replay look like the replay's keys (A/D alternate, 0 rows with no key), not the local player's.
  - Practice mode and bhopping back into the start zone both end the timer as DISABLED (`stop`), not PRIMED. (Later test, same day: bhopping back in gave PRIMED; see the end reasons above.) A reset gave PRIMED; one other attempt ended as DISABLED after 11.6 s from an unknown cause.
  - Non-finish ends read `runTime` 0 after the state change, so the recorder now keeps the last `runTime` seen while running.
- **Collector v1 (2026-10-27).** `collector/collector.py`, with the wire-format reader in `collector/srrec.py` (also used by `check_recorder.py`).
  - Reads `yaw.log` from the start, then follows it. Only complete lines count. A truncated or replaced log is read again from the start.
  - Saves each complete attempt to `~/.local/share/strafe-review/attempts/<map>/<id>.json.gz`: the attempt's JSON exactly as the recorder sent it. Files are written to a temp name and renamed, so a reader never sees half a file. This path and layout are part of the stable format.
  - An attempt whose file already exists is skipped, so re-reading the whole log is safe. Chunks with no end line for 10 minutes are dropped.
  - Started by the Steam launch option wrapper `collector/strafe-review-run` (linked into `~/.local/bin` by `collector/install.sh`): `strafe-review-run sourceyaw-run %command%`. It runs the collector while the game runs and logs to `~/.local/state/strafe-review/collector.log`. Not hooked into Source Yaw's own `sourceyaw-run`: Steam runs the installed copy, and the public repo must not name this project.
  - Tested without the game on the play-test log: 6 of 6 attempts saved from uneven slices, none saved twice after a restart, recovery after truncation, and the same files as `check_recorder.py --save`.
- **Tickrate.** Momentum surf maps run at 66 ticks per second and bhop maps at 100. Store the tick interval with every attempt.
- **Labels.** Every recording is labelled as one of: your own run, someone else's replay, or a ghost. The label is shown everywhere it appears.
- **Retention.** Every attempt is kept, compressed. The viewer has a manual "delete older than" button.
  - Rough size: about 40 bytes per tick, so roughly 12 KB for a 3-second failed first jump.
  - Keep the file format stable, because the progress view reads old attempts.

## Viewer

### Viewer v1 (2026-10-27)

Main view only, as chosen by the owner; the mistake checks come next.

- **Files.** `viewer/server.py` (stdlib, `127.0.0.1:8765`, `--port`, `--store`) and `viewer/static/` (plain HTML, CSS and canvas JS; no build step, no CDN).
  - `/api/attempts` lists every attempt's header without rows, newest first, cached by file mtime and size.
  - `/api/attempt/<map>/<id>` sends the `.json.gz` file as it is, with `Content-Encoding: gzip`. The map and id are checked against strict patterns, so no path leaves the store.
- **Rows are read by the names in `cols`**, so files with added columns still load. Rows are placed by `tick`, and lines break at missed ticks.
- **Findings from the saved attempts (2026-10-27):**
  - The `move` column (`moveStatus`) reads 0 on every row of all 15 attempts, ground included. Ground is taken from `vz == 0` instead (a 0 between rising and falling is an apex, not ground). A takeoff is `vz` going from 0 or less to over 100, also across a gap. A later recorder fix should add a new column at the end, not reuse `move`.
  - A `jump` event comes on the tick before its takeoff. Its `gain`, `sync` and `ratio` describe the air time that just ended, not the jump starting. `sum(gain) / sum(ideal)` over an air segment's rows gives the same gain % (jump 1 of the finished test run: 71.0 % both ways), so the viewer uses the rows.
  - Every air tick adds exactly 30 u/s square to the velocity: `sqrt((v + ideal)^2 - v^2)` = 30.00. So the optimal turn per tick is `atan(sqrt((v + ideal)^2 - v^2) / v)`. Measured yaw speed over this matches the game's `yawRatio` (median 0.78 vs 0.79, correlation 0.96 over 4 ticks).
  - Replays have no tick stats, so for them `gain` is the change in horizontal speed and `ideal` is `sqrt(v^2 + 30^2) - v` (both match own runs to 0.01). `ratio` is the averaged yaw speed over the optimal one. The page says so in the header.
  - Yaw going up is a left turn: in air, the held A or D matched the turn direction on about 99 % of ticks.
  - In own runs, `+left` (bit 128) is held with W and A in the start zone and into jump 1. The owner confirmed this is on purpose: they often hold `+left` while prestrafing. Those ticks turn at the fixed `cl_yawspeed`, so the checks must not judge them as mouse turning.
- **What it draws.** Lanes share one x axis (ticks from the timer start, with seconds):
  - Jump strip with gain % (red at 60 %, green at 95 %). Jump 1 is the air segment in progress when the timer starts, else the next one; earlier hops are `pre`.
  - Yaw speed: per tick (thin), 5-tick average (thick), optimal line with an 85-115 % band.
  - Angle: `yawRatio` around 1, too wide in orange and too narrow in blue.
  - Gain vs ideal, with lost gain shaded red.
  - Keys: W, A, D, the ideal key (turn direction), a red "Wrong" row (turning without the matching key held) and `+left`/`+right`.
  - Speed, with ground ticks shaded in every lane and takeoff marks.
  - Missed ticks.
- **Scales** use the 98th percentile of rows in the air at 100+ u/s, so a fall at near-zero speed (ideal gain near 30) or a teleport tick doesn't squash a lane.
- **Controls.** Wheel to zoom at the pointer, drag to pan, double-click for the whole attempt, click a jump to zoom to it, and a "Jump 1" button. Hover shows exact values in a bar above the graph. The URL hash keeps the open attempt.
- **Label** (`Own run` / `Replay: <player>`) is shown in the list and in the header.

### Main view

- **Layout.** One continuous, zoomable graph, with time in ticks on the x axis shared by all lanes.
  - A **jump strip** on top shows jump number and gain%. Clicking a jump zooms to it.
  - A **mistake list** below links each mistake to its tick. Clicking it jumps there.
  - Mouse wheel zooms, dragging pans, and hovering shows exact values.
- **Lanes:**
  - **Yaw speed vs optimal:** your turn rate in degrees per tick, against the optimal band for your current speed.
  - **Angle vs optimal (`yawRatio`):** above 1 means too wide, below 1 means too narrow.
  - **Gain vs ideal:** `speedGain` against `idealGain`, with lost gain shaded red.
  - **Keys vs ideal key:**
    - A/D bars with the correct key underneath.
    - Wrong key, no key, and early or late switches are shown red.
    - `+left`/`+right` turn-button ticks are shown separately.
  - **Speed + ground:** speed line, ground ticks shaded, takeoff and landing marks.
  - **Lost-tick gaps:** ticks the HUD missed.

### Mistake checks

Each check can be switched on or off in the viewer settings. Thresholds start as defaults and get tuned once real runs are recorded.

- **Early reversal:** the first strafe after takeoff is too short, so you switched the other way too soon after the prestrafe.
- **Late first strafe:** ticks between takeoff and the first air strafe.
- **Weak takeoff:** takeoff speed or angle worse than your usual on this map.
- **Too wide / too fast:** `yawRatio` above optimal for several ticks.
- **Too narrow / too slow:** `yawRatio` below optimal for several ticks.
- **Uneven turn speed:** big swings in turn rate inside one strafe. Turn-button ticks turn at a fixed `cl_yawspeed` and must not be judged as mouse turning.
- **Left/right imbalance:** one direction consistently better or worse.
- **Wrong key:** turning one way while holding the opposite strafe key.
- **No key while turning:** dead ticks.
- **Early/late switch:** the key switch offset in ticks from the turn reversal. The target is -1, as in the Source Yaw trainer.
- **W held in air:** optional and off by default, because many players use jump binds that release W.

### Comparison

- **WR / top-replay overlay:** watch a top player's replay in game and the recorder records it. Their jump 1 is drawn as a ghost line over yours in every lane.
- **Your best attempt ghost:** your best jump 1 on this map, drawn behind the current attempt.
- **Gain-loss ranking:** mistakes ranked by speed lost (for example "early reversal cost 23 u/s"), so the biggest one gets fixed first.

### Practice

- **Jump-1 drill view:** jump 1 of every attempt in the session, side by side and stacked, with best, median and consistency.
- **Live page update:** the page refreshes the moment an attempt ends, with no clicking. Nothing ever pops up over the game, because overlays and popups on the game make it stutter.
- **In-game one-liner (on/off toggle):** after jump 1 lands, the existing Source Yaw in-game overlay briefly shows the single biggest mistake, for example "reversed 3t early".

### Detail

- **Per-strafe table:** for each strafe inside a jump: ticks, degrees turned, average gain, sync and direction.
- **Mouse-terms advice:** the optimal yaw speed converted into mouse movement, for example "strafe 1 needs about 4.1 cm, you did 6.0 cm".
  - It uses `sensitivity` and `m_yaw` from `config.cfg`.
  - You type your mouse DPI in once, in the settings.
- **Top-down path:** a small view of the path from above, coloured by gain. Clicking a point jumps to that tick.
  - The path is built up from velocity and resets on teleport.
  - The shape is right but not exact down to the unit, which is accepted.

### Organising

- **Notes and tags** per attempt (for example "new sens"), with a filter by tag.
- **Filters** by map, tickrate, style (normal, sideways, HSW) and finished or failed.
- **PNG export** of a graph or jump view.

## Later / undecided

- **Progress over time (non-urgent):** graph stats across saved attempts over days and weeks, such as jump-1 gain, sync, yaw ratio and mistake counts.
- **Viewer as a tab in the Source Yaw GTK app:** to be decided later. The web page comes first.
- **Raw mouse dx lane:**
  - Panorama only sees view angles.
  - Real sub-tick mouse data (about 1000 Hz) exists only in Source Yaw's input service.
  - It would be logged with timestamps and merged into the run afterwards.
  - Deferred until the first version works.
- **CS:S version:** input-only, simulating Source air movement from yaw, keys, `sv_airaccelerate` and tickrate.

## First step when building starts

A tiny recorder in `custom/` that prints jump-1 gain and the button bits to `yaw.log`. It answers three questions that everything else depends on:

1. Does a custom script in `custom/` load?
2. Do long `$.Msg` lines reach `yaw.log` whole, or get cut off?
3. Does writing a whole run in one go make the game hitch when you reset straight into the next attempt?

If writing everything at once hitches, spread the output over several frames.
