# Strafe Review: plan

Status: probe done (`recorder/probe/`, results below). Recorder v1 written and play-tested (`recorder/panorama/scripts/hud/strafe-review.ts`, checked by `recorder/check_recorder.py`). Collector v1 written (`collector/`, see "Collector v1" below). Viewer v1 (main view) written (`viewer/`, see "Viewer v1" below). Mistake checks v1 written (see "Mistake checks v1" below), not yet tried by the owner on new runs. Jump-1 drill page written (see "Jump-1 drill v1" below).

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
  - Finished own runs also land in `momtv/local/<map>/temp/` even with `mom_tv_replay_save_mode 1` (5 bhop_ambience files there on 2026-10-27).
- **`.mtv` contents (checked 2026-10-27).**
  - Header: map name, a hash, player name, SteamID, then a length-prefixed JSON of splits and stats (jumps, max speed). The public website repo (`momentum-mod/website`, MIT, `libs/formats/replay`) reads only this part; it calls the C++ layout in `momtv.h` "licensee-only".
  - Body: Valve LZMA (`LZMA` magic, real size, packed size, 5 props bytes), opens with Python `lzma` `FORMAT_ALONE` after rebuilding the header. Inside: send-table names for `CMomentumPlayer` and others (`m_vecOrigin`, `m_angEyeAngles[0/1]`, `m_vecVelocity[0-2]`, `m_nPhysicalButtons`, `m_fFlags`, `m_iLandTick`, `m_iJumpTick`, ...), then a bit-packed entity delta stream.
  - So the file holds everything the recorder needs, but the stream has no bit widths or encodings. Decoding it means reverse-engineering closed game code, and it could break on any update. Not pursued for now.
- **Unfocused game.** Source sleeps 50 ms per frame when the window has no focus (`engine_no_focus_sleep 50`), about 20 fps. A replay watched while tabbed out records only every 5-6th tick (player B replay, 2026-10-27: 634 of 1878 run ticks missed).
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
  - `spectate` (added 2026-10-28): a live player being spectated. Before this label existed, these were saved as `own` with every tick stat 0 (3 bhop_glacial attempts). The recorder sets it when it isn't a replay and either `MomentumSpectateStart` came without a `MomentumSpectateStop` or `GetMoveType()` is OBSERVER (10), which covers a `panorama_reload` mid-spectate. `player` comes from the built-in `#Spectator` HUD panel's `name`. The in-game line is off for these. Live check passed 2026-10-28 (label and name stored).
  - Old files: the server's `head()` and `parse()` in `static/data.js` relabel an `own` attempt as `spectate` when it has 20+ air rows and none of them has a non-zero `ideal`. The files themselves are not rewritten. In the viewer, `isOther(h)` (anything not `own`) replaces the old `label === 'replay'` tests: other players' recordings are kept out of own stats, PBs, the drill and the takeoff median, and they skip the key-timing checks like replays. `whoseRun(h)` gives "Replay: name", "Spectated: name" or "Own run".
  - **Coarse speed (2026-10-28):** a spectated live player's velocity only changes about every 5th tick (network updates; 214 of 1073 air rows on one run), so the gain rebuilt from speed is 0 on most ticks and the whole change on one. `parse()` sets `d.coarse` when the recording has no tick stats and velocity changes on fewer than half its air rows (all 8 such recordings on disk are spectated, no own runs or replays). Owner's pick: per-jump % only. The gain lane shows a note instead of the line, the checks are off, the readout says "per jump only", and the path is coloured by the jump's %. In coarse rows a drop of more than 100 u/s in one row (the finish wall, 963 to 61 u/s) is left out of the jump's %, which had read -515 %.
- **Wire format 1.** Every line is `[panorama] SRREC <id> ...`:
  - `<id> <i>/<n> <text>`: chunk i of n, at most 900 characters. The chunks joined in order are one JSON object.
  - `<id> end n=<n> chars=<c>`: last line; an attempt with missing chunks is dropped.
  - JSON fields: `format, id, started, map, interval, style, track, label, player, replayFile, practice, version, mouse, cols, preRows, rows, events, reason, runTime, gaps, ended`.
  - `mouse` (added 2026-10-27, optional, so older files lack it): `{sensitivity, m_yaw, cl_yawspeed, dpi}` read when the attempt starts. `dpi` is what Momentum's own mouse settings page stored (`$.persistentStorage` `settings.mouseDPI`), or null. `mouse` is null if the HUD couldn't read the settings.
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

**Next step (chosen 2026-10-27): all 11 checks in one batch**, plus the mistake list under the graph: click a row to zoom to its ticks, rank by speed lost (u/s = sum of ideal - gain over the ticks involved), checks on/off and thresholds in a settings panel (saved in the browser). Only jumps 1+ and rows up to the run end are checked. `+left`/`+right` ticks are never judged as mouse turning.

Measured on the 14 own attempts (bhop_ambience, 100 tick), to set the first defaults:
- Strafe length (a strafe = a run of one turn direction inside a jump): first strafe after takeoff median 29 ticks (5-95 %: 3-74), middle strafes median 32 (23-51).
- Key switch offset from the turn reversal (ticks, target -1): -1: 32, -2: 23, 0: 35, 1: 15, 2: 5, 3: 7, 4: 3, -3: 3, -4: 4; a few at -8 to -5 and 7. 132 switches in total.
- Delay from takeoff to the first correct key while turning: 0 ticks almost always (95 % at 2).
- `yawRatio` at 100+ u/s in the air: median 0.66 (25-75 %: 0.39-0.83, 95 %: 1.16). Switch ticks pull it down, so wide/narrow should skip a few ticks at each strafe's ends.
- Jump-1 takeoff speed: median 282 u/s (5-95 %: 253-286).
- Weak takeoff needs other attempts on the map: plan is for the server to add each attempt's jump-1 takeoff speed to its list header, so the page can compare against the median of own attempts.


Each check can be switched on or off in the viewer settings. Thresholds start as defaults and get tuned once real runs are recorded.

#### Mistake checks v1 (2026-10-27)

- **Files.** `viewer/static/data.js` (parse and jump finding, moved out of `app.js` so node can load it), `viewer/static/checks.js` (the checks, pure functions, default thresholds in `CHECKS`) and `viewer/check_mistakes.js` (node harness: `node viewer/check_mistakes.js [--list]` prints mistakes per attempt, counts per check and the strafe stats below).
- **Strafe split.** A strafe is a run of one turn direction (`ideal_key`, the 5-tick average yaw past 0.3°/tick) inside a jump. Ticks with no clear turn don't break it. Strafes or switches that span a missed tick are skipped.
- **Rows judged.** Only jumps 1+, cut at the run end, and only rows in the air at 100+ u/s (falling at near-zero speed has ideal gain near 30 u/s per tick and swamped the loss sums). Ticks losing more than 10 u/s are collisions (one wall hit read -234 u/s and made a run look 20 % left vs 83 % right), so they are left out too.
- **`+left`/`+right` ticks** are left out of the checks that judge how the mouse turned: wide, narrow, uneven, imbalance, wrong key and no key. The Keys lane no longer draws them as "Wrong". Timing checks (early reversal, late first strafe, switch) still count them: 10 of 15 own jump 1s take off with `+left` held, and skipping those hid jump 1 from exactly these checks.
- **Speed lost** = sum of ideal - gain over the rows involved. Imbalance: the worse side's ideal times the gap. Weak takeoff: median minus this takeoff.
- **Weak takeoff baseline.** `server.py` adds `j1Takeoff` to each list entry (a Python copy of `findJumps`; matches the JS on all 15 own attempts). The page takes the median of the other own attempts on the same map and tick interval.
- **Settings** are saved in `localStorage` as only the values that differ from the defaults, so changed defaults still reach the owner.
- **Defaults** (set from the 15 own attempts, 2026-10-27; one more than above):
  - Early reversal: first strafe under 18 ticks (jump 1 only since tuning round 1). It's counted from where that turn began, which in a bhop is usually before the landing; counted from takeoff it flagged most later jumps. Jump 1's first strafe was 21-34 ticks; later jumps 5 %: 27.
  - Late first strafe: first correct key more than 3 ticks after takeoff.
  - Weak takeoff: 8+ u/s under the median, with 5+ other attempts.
  - Too wide: strafe-middle median `yawRatio` over 1.1 (strafe medians: 95 % at 1.11; 1.2 since tuning round 1). Too narrow: under 0.4 (10 % at 0.38). 3 ticks skipped at each end, 8+ tick strafes, one entry per strafe.
  - Uneven: (90th - 10th percentile) / median of the 5-tick average turn speed over the strafe middle, over 0.9 (95 % at 0.95). Raw per-tick yaw is too jumpy for this.
  - Imbalance: left vs right gain % differ by over 12 points, 4+ strafes per side; one entry per run.
  - Wrong key / no key: 2+ ticks in a row (no key 3+ since tuning round 1), not within 4 ticks of a reversal (those are the switch check's).
  - Switch: offset of the nearest key switch (within 8 ticks) from the reversal; flagged at 4+ ticks early or 2+ late.
  - W held in air: off; 5+ air ticks with W.
- **Re-measured with this split** (15 own attempts): switch offsets -7: 1, -6: 1, -5: 4, -4: 5, -3: 8, -2: 30, -1: 39, 0: 46, 1: 20, 2: 4, 3: 7, 4: 3, 7: 1 (169); middle strafes median 31 (5-95 %: 20-49). The earlier 132-switch figure came from a different split.
- **Replays skip key timing** (late first strafe, wrong key, no key, switch): the WR replay's switches all sat 3-7 ticks before the turn (own runs centre on -1), so its keys run ahead of its view angles. Before this, the replay listed 57 mistakes. The list now scrolls in its own 360 px box.
- **Too narrow at 0.00** means the yaw stopped in the middle of a strafe (keys held on 25-57 % of those ticks, gain 4-10 of 35-44 u/s ideal). The entry then says "barely turning".
- **First counts** with everything on (16 attempts incl. 1 replay): early 5, late first 11, takeoff 3, wide 12, narrow 18, uneven 8, imbalance 1, wrong key 15 (13 in the replay, whose keys seem to lag the turn), no key 9, switch 54 (36 in the replay). Jump 1 of own runs: 4 switch entries (switched 4-6 ticks early on the first reversal after the `+left` prestrafe).
- **Tuning round 1 (2026-10-27, owner's picks).** New data: 15 jump-1 drills, 2 finished runs and 3 top replays (player A, player B, player C). Changes:
  - Too wide: 1.1 to 1.2. Top replays sat at 1.10-1.17 (3-6 per run); the owner's real outliers read 1.33-1.37.
  - Early reversal: jump 1 only. Top replays reverse after 10-17 ticks on later, faster jumps (player C: 6 hits).
  - No key: 3+ ticks. The 2-tick hits were blips on drill jump 2, about 2 u/s each.
  - Weak takeoff: a jump-1 takeoff under 150 u/s (`MIN_TAKEOFF`) is neither judged nor counted in the median. It fired on a reset before jumping (34 u/s) and a replay fragment (0 u/s).
  - Counts on 53 attempts: early 18 to 1, wide 42 to 9, no key 26 to 9, takeoff 10 to 8.
  - Kept: the jump-1 switch "D 4-5 ticks before the reversal" after the `+left` prestrafe fires on 7 of 11 drills at 5.6-7 u/s each. The owner can't feel it, so it stays flagged as the main thing to practise.

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

### Jump-1 drill v1 (2026-10-27)

The owner asked for a separate page that updates by itself the moment an attempt ends.

- **Files.** `viewer/static/drill.html`, `drill.js`, `drill.css`, served at `/drill`. A link sits at the top of the main page's list, and an "All attempts" button sits on the drill page.
- **Live update.** `/api/events` is a server-sent event stream. The server scans the store every 0.5 s and sends `attempt` with `{dir, id}` for each new file. A `: ping` comment goes out every 15 s. The collector writes `.<id>.tmp` and renames it, so a half-written file never matches. The drill page fetches only the new attempt and redraws. The main page reloads its list on the same event, and the open attempt stays open.
- **Which attempts.** The map picker lists map + tickrate, newest first. It follows the newest attempt's map until the owner picks one by hand. "Latest session" means own attempts with under 30 min between consecutive starts, counted back from the newest. "All on this map" is the alternative.
- **Jump 1** comes from `findJumps()` as on the main page. Rows are put on ticks from takeoff. It is **cut short** when the run ended (`endIdx`) before the landing. Cut-short attempts are shown but not counted. Replays never count: a replay whose jump 1 landed is drawn as a dashed, labelled reference line and listed under the stats.
- **Stats** (over landed own jump 1s):
  - Best = highest landing speed, because that is what jump 1 hands to the run.
  - Median landing and median takeoff.
  - Consistency = landing IQR, shown as ± half of it.
  - Median gain % with its IQR.
  - Last 5: the median landing of the last 5 minus the median of all shown, when 8+ are shown.
  - Most common jump-1 mistakes: checks from `runChecks()` with `jump === 1`, using the main page's saved check settings. Each one shows how many attempts it fired in and the mean u/s lost.
- **Charts.**
  - Landing speed per attempt: dots, oldest left, coloured by gain %, with the median dashed. Cut-short attempts are hollow marks on the floor.
  - Stacked lanes, aligned on takeoff: speed, turn speed (5-tick average, signed) and lost so far (running sum of ideal - gain over rows at 100+ u/s with no collision). All attempts are faint; best is green, latest blue, the tick-by-tick median white dashed and replays orange dashed.
  - Side-by-side cards, newest first: speed and turn speed minis on a shared scale, takeoff to landing, gain %, ticks and the biggest jump-1 mistake. A card that arrived live flashes once.
  - Hovering a card, dot or line picks that attempt out everywhere. Clicking opens `/#<map>/<id>/j1`, which the main page opens zoomed to jump 1.
- **Focus panel (added the same day, owner: "no easy way to see what I did wrong in the exact last jump").** It sits at the top and shows the latest attempt's jump 1. It moves to each new attempt as it arrives. Clicking a card, dot or stacked line focuses that attempt instead, with "Back to latest" and "Open in main view" buttons.
  - "Usual" = the median over the other landed own attempts shown, per strafe index (strafe 1, 2, 3...).
  - Per-strafe table:
    - Columns: ticks, gain %, lost u/s, angle (median `yawRatio`, 2 ticks skipped at each end, `+left`/`+right` ticks left out), key held % and switch offset from the reversal (aim -1).
    - Each value has your usual next to it in grey.
    - Values turn red only in a strafe that lost 3+ u/s more than usual, because a different angle that cost nothing is not a mistake.
  - Tips, biggest loss first:
    - The strafe that lost the most over its usual, with plain reasons: turned slower or faster (angle off by 0.12 or more), matching key held 10+ points less, switch at -3 or earlier or at +1 or later, 8+ ticks shorter, `+left` held.
    - Air runs of 8+ ticks with no turn after the first strafe ("keep strafing until you land").
    - The top check that fired, with a one-line fix.
  - Focus chart:
    - Lanes: speed (this jump, usual, best), turn speed with this jump's optimal turn and its 85-115 % band, keys (needed key vs held, red when wrong or none) and lost vs usual (up = worse).
    - Strafe starts are dashed lines, and check ranges are shaded red. Hover shows every value at a tick.
- **Replays recorded twice.** Momentum replays open with the end of the player's previous run and a reset: 940-958 u/s, then a teleport to 0, inside the 2 s kept before the timer starts. `findJumps` already skips it. A replay that starts over after its end is recorded again until it is stopped: player D gave a second 4-row attempt ending as `replaced`. The drill page keeps only the longest recording per `replayFile`, and only replays whose jump 1 landed.
- **Drills vs runs (owner, 2026-10-27).** A drill is an own attempt that didn't finish and landed 7 jumps or fewer. That covers jump-1 and SSJ practice ("6 or 7 jumps, as SSJ is a big thing in bhop").
  - `server.py` adds `landed` to each list entry: jumps from jump 1 on that landed before the run end.
  - The main page hides drills by default, behind a "Show drills (N)" toggle saved in the browser. Shown drills get a purple "Drill · N jumps" chip.
  - The drill page always uses every own attempt.
- **Replay fragments** are never listed on the main page, unless one is the open attempt. A fragment is a replay recording with no landed jump, or a shorter copy of a `replayFile` that was recorded again.
- **Known limit.** Attempts already loaded keep the weak-takeoff verdict from load time while new attempts come in. Reload the page to redo it.

### Comparison

- **WR / top-replay overlay:** watch a top player's replay in game and the recorder records it. Their jump 1 is drawn as a ghost line over yours in every lane.
- **Your best attempt ghost:** your best jump 1 on this map, drawn behind the current attempt.
- **Compare specific recordings (owner, 2026-10-27):** pick any own run or replay on the same map and tickrate and draw it over the open one. Built with the ghost overlay below.
- **Alignment (owner's pick, 2026-10-27):** a toolbar switch between "per jump" (default) and "timer start".

- **Compare page (owner, 2026-10-27).** The ghost alone was not enough. The owner wants a clear replay-vs-replay view, "perhaps more", with general stats such as average gain and sync.
  - It is a new `/compare` page that takes 2 to 4 recordings: own runs or replays, same map and tickrate. The main view keeps its single ghost.
  - The first pick is the reference. The others align to it with the same per-jump / timer-start switch.
  - Each recording gets its own colour on one shared graph. The lanes are speed, yaw speed, angle and gain.
  - A stats table has one column per recording. The owner picked all four stat groups:
    - Strafing averages: gain %, sync, angle, strafes per jump, % of air time turning.
    - Run, jump 1 and speed: run time and end, jumps landed, jump-1 takeoff, landing and gain %, max, average and final speed.
    - A per-jump table of gain % and sync, with the best in each row marked.
    - Mistake-check counts and u/s lost.
  - Sync is measured the same way for every recording: held key vs turn direction. Each recording's keys are shifted by the lag that matches best, because replay keys run ahead of the angles.

#### Compare page v1 (2026-10-27)

- **Files.**
  - `viewer/static/compare.html`, `compare.js` and `compare.css`, served at `/compare`.
  - `stats.js` holds the summary stats with no DOM. `viewer/check_stats.js` prints them per attempt.
  - Links: "Compare →" next to "Drill →", and a "Compare page" button in the main toolbar that opens the open attempt and its ghost.
- **URL.** `/compare#<map>/<id>,<id>,...`, with the first id as the reference.
- **Picker.**
  - The list holds every recording on the map + tickrate picked at the top, with no replay fragments. Drills are behind a "Show drills" toggle.
  - A one-column list with fixed columns (label, started, end, jump-1 landing, action), so picking a row never resizes it. Click a recording to add or remove it, up to 4. "Make reference" moves a pick first.
  - Missed ticks use `runGaps()`, inside the run only. The attempt file's `gaps` also counts a replay's pause after its end (1499 for player A vs 3).
- **Colours.** Blue, pink, amber and violet in pick order. Green and red are left out, because they mean optimal and loss.
- **Stats** (`summarize()`): definitions are shared with the rest of the viewer, so the same jump shows the same number everywhere.
  - **Gain %:** sum(gain) / sum(ideal) over jumps 1+, as the jump strip.
  - **Sync (keys vs turn):** A or D alone matching the turn side on strafing ticks, with `+left`/`+right` ticks out. Each recording's keys are shifted by the lag (-10..10 ticks) that matches best. Replays come out at 5-7, own runs at 1, measured the same way for all. Replay sync is marked approximate. This is not the game's own sync number.
  - **Angle:** the drill page's median `yawRatio` rule.
  - **Strafes per landed jump** and **% of strafing ticks turning**.
  - **Run:** end, jumps landed and missed ticks. A replay that ended `replaced` reads "Replay stopped at X s", never as a finish. (Since 2026-10-28 a replay played to the end is a finish, see "Replay finishes".)
  - **Jump 1:** takeoff, landing and gain %.
  - **Speed:** max, average and at the end. "At the end" is noted as at the finish or at the end of the recording.
  - **Mistakes:** `runChecks()` with the main page's settings. For replays the key checks and weak takeoff are not run, and the table says "not run (replay)" rather than 0.
  - Checked against the jump strip: mvr5wa45va jump 1 79.03 %, player A 90.57 %, mvr4ohct1z 81.42 %, mvr5qqnsk0 83.03 %.
- **Per-jump table.** Gain %, sync and strafes per jump, matched by number, with the best in each row starred. A note shows when jump counts differ.
- **Graph.** Lanes: a jump strip (one row per recording), speed, yaw speed (5-tick average, with the reference's optimal band), angle and gain (with the reference's ideal dashed).
  - Scales cover every shown recording.
  - Each recording is cut at its run end (`runEnd()` in data.js: before `postRows` and no later than `runTime`). A replay paused at its end keeps sending rows.
  - Hover shows every recording's values at that x, with each one's own tick.
- **Teleport fix (owner report, 2026-10-27).** player C's replay showed a "pre" hop at -193 ticks with 837 %. A replay opens with the end of the player's previous run. Row 10 goes from 0 to 531 u/s in one tick, a teleport, and the rebuilt gain counted it as +530 against an ideal of 30.
  - `findJumps()` drops hops that end before the last teleport ahead of the timer start. A teleport here is speed going from 100+ to under 1 u/s, or the other way, in one tick.
  - The rebuilt-from-speed gain leaves out any rise above 30 u/s in one tick.
  - Jumps with no measurable row stay "?", as in player B's replay with 634 missed ticks.
- **Fixed in passing.** `findJumps()` now skips rows with no gain, such as a replay row after missed ticks. Before, one such row turned the whole jump's gain % into NaN ("?" on the strip).

#### Ghost overlay v1 (2026-10-27)

- **Picker.** "Compare" sits in the main toolbar. It offers None, three presets and "Pick one".
  - The presets are "Your fastest finish", "Your best jump 1" (highest jump-1 landing) and "Top replay".
  - "Pick one" lists every recording on the same map and tickrate except the open one and replay fragments.
  - The choice is saved per map + tickrate in the browser (`strafe-review-compare`), and the alignment in `strafe-review-align`. Presets move with new attempts: when the SSE list reload changes what a preset points at, the ghost reloads.
  - The URL hash is unchanged, so `#map/id/j1` from the drill page still works.
- **Top replay.** A replay recording can stop early, which makes its `runTime` short. Only replays within 75 % of the longest replay time count, and the shortest of those wins. Top players on bhop_ambience land 24 jumps where the owner lands 26, so "most landed" is not a completeness test.
- **`server.py`** adds `j1Land` to each list entry: jump 1's landing speed, or null if it didn't land before the run end.
- **Alignment.** `alignGhost()` in `data.js` lines the ghost up with the open attempt:
  - Per jump: jumps are matched by number. The ghost's jump-k air keeps its own spacing, shifted onto the open jump-k takeoff. Its ground after it is stretched or squeezed to end at the next matched takeoff. Rows that would run past it are left out, and the line breaks there.
  - Rows before jump 1 take the jump-1 shift. Rows after the last matched jump keep the last shift. With no jump number in common it falls back to the timer start and the header says so.
  - Jumps are matched by number, not by place on the map. A replay that skips jumps (top players skip 2 on bhop_ambience) pairs different blocks after the skip. Use "timer start" there.
  - `viewer/check_ghost.js` checks every pair of saved attempts: matched takeoffs land exactly, and x never goes down. 2756 pairs passed, 3606 of 2.25 M ghost rows left out.
- **Drawing.** The ghost is dashed pink (`#ff79c6`, not used elsewhere) and drawn behind the open attempt. Lane scales come from the open attempt only.
  - Yaw speed: 5-tick average. Angle: `yawRatio` as a line. Gain: the gain line. Speed: the speed line.
  - Jump strip: a pink bar where the ghost's air time sits, and "ghost N %" in the label when it fits.
  - Keys: thin pink A and D strips, only for own ghosts. Replay keys run 3-7 ticks ahead of the angles, so they are not drawn, and the header says so.
  - Hover: the ghost's row at the same x (within half a tick) shows where, speed, gain, yaw and ratio.
- **Labels.** A pink header chip names the ghost: own run or `Replay: <player>`, the preset, the time and end, and the alignment with the matched jump count. A second chip says when the ghost's gain and angle were rebuilt from speed.
- **Gain-loss ranking:** mistakes ranked by speed lost (for example "early reversal cost 23 u/s"), so the biggest one gets fixed first.

### Practice

- **Jump-1 drill view:** jump 1 of every attempt in the session, side by side and stacked, with best, median and consistency.
- **Live page update:** the page refreshes the moment an attempt ends, with no clicking. Nothing ever pops up over the game, because overlays and popups on the game make it stutter.
- **In-game one-liner (on/off toggle):** after jump 1 lands, a line on the HUD briefly shows how it went.

#### In-game line v1 (2026-10-27)

- **Native HUD label, not the Source Yaw overlay (owner's pick).** The recorder already runs in Momentum's Panorama HUD, so it draws the line itself: a panel (`#StrafeReviewLine`) added to the HUD root, at the top middle of the screen (owner's pick; the built-in jump stats moved to the top left in the owner's `cfg/hud/bhop_bhopp.kv3` to make room), shown for 4 s. No overlay window, so no stutter, and Source Yaw stays out of it. It isn't cleared on reset, because in drills the owner resets straight after landing and reads it then.
- **Fields (owner's list):** landing speed, jump-1 gain %, gain % per strafe, plus the biggest jump-1 mistake with its loss.
- **Layout (owner's pick, after one line was hard to read):** 3 rows. Row 1 `J1 377 u/s · 83.12 %`, row 2 one box per strafe (`A 88.0 %`, `D 79.5 %`) filled with the drill page's gain colour (red at 60 %, green at 95 %), row 3 `D switch 5 ticks early (-5.7 u/s)`.
- **Toggles:** one `SHOW` constant at the top of the line code in `strafe-review.ts` for now. The owner wants every field switchable later (a toggle UI is a later step; the viewer's settings live in browser localStorage, which Panorama can't read, so it would need its own channel, e.g. `$.AsyncWebRequest` to the viewer server or a generated settings file).
- **Worked out in the game.** Jump 1 lands mid-run, long before the attempt reaches the collector, so the recorder computes the line itself from the rows it already holds: a TS port of `data.js` `parse`/`findJumps`, the drill page's per-strafe gain % and the jump-1 checks of `checks.js` (early reversal, late first strafe, wide, narrow, uneven, wrong key, no key, switch) at their **default** thresholds. Weak takeoff (needs other attempts) and imbalance (whole run) are left out. Changed thresholds in the viewer settings don't reach the game.
- **When.** The recorder scans new rows for a landing (vz from below 0 to exactly 0, or a takeoff, since a missed landing tick goes straight from falling to the next jump) and works the line out 3 rows later, since the 5-tick turn average reads 2 rows ahead. If jump 1 hasn't landed yet (the landing was an earlier hop), it waits for the next landing. Own attempts only: tick stats read 0 while spectating a replay.
- **Logged** as `[panorama] SRLINE <id> <json>` in yaw.log (start, landing row, land, gain %, strafes, all jump-1 mistakes). The collector only reads `SRREC` lines.
- **Parity check:** `node viewer/check_line.js` feeds every saved own attempt row by row through the recorder code (types stripped by node, Panorama stubbed) and diffs it with the viewer's numbers: 44 of 44 identical on 2026-10-27, line shown at landing + 3 rows on all. `--log [yaw.log]` compares the lines the game really logged with the saved attempts.
- **Live test (2026-10-27):** after `panorama_reload` and a jump-1 drill session, `check_line.js --log` compared 76 lines the game logged with the saved attempts: 0 differ (1 attempt skipped, no landed jump 1).
- The port must follow changes to `data.js`, `checks.js` defaults or the drill's per-strafe gain %. `check_line.js` catches drift.

#### Mouse-terms advice v1 (2026-10-27)

- **Formula:** cm = degrees × 2.54 / (DPI × sensitivity × m_yaw), the same as Momentum's mouse settings page. Both pages show the cm per 360° next to the DPI box, so it can be checked against the game's page.
- **Sens per attempt:** the recorder stamps `mouse` into each head (see the wire format), so a sens change shows up between attempts. Older attempts use the game's current `sensitivity`/`m_yaw` from `cfg/config.cfg` (`/api/mouse`; the game writes it when it quits) and say so.
- **DPI:** typed in once in the viewer (drill page toolbar or the main page's check settings; stored in localStorage `strafe-review-mouse`, shared by both pages). If the box is empty, it is pre-filled from the newest head with a Momentum-stored DPI.
- **Drill page:** a Mouse column in the per-strafe table: how far the mouse moved in the strafe (net turn in the strafe's direction) next to the optimal turn over the same ticks. The "turned slower/faster than usual" advice adds both in cm. Ticks with +left/+right held, missed ticks and rows the checks don't judge are left out.
- **Main view:** the hover readout shows the 5-tick average turn and the optimal as mouse speed in cm/s. For a replay it says "at your sens": the speed you'd need to copy it, not the player's own mouse movement.
- **In-game line:** unchanged (no cm there), so `check_line.js` parity is untouched.
- **Check:** `node viewer/check_mouse.js [--dpi N]`: the formula against Momentum's, `strafeTurn()` on hand-made rows, then jump-1 strafes of saved attempts in cm. Over 290 own strafes of 10+ ticks, moved/optimal has a median of 0.84, in line with the usual yawRatio of about 0.8.
- **Open:** whether Momentum's HUD context can read `$.persistentStorage` and `GetSettingFloat` (both seen only in menu pages so far). The recorder logs `[panorama] SRREC mouse {...}` on load; an error shows up as `err mouse`. Neither ever stops an attempt from being recorded.

### Detail

- **Per-strafe table:** for each strafe inside a jump: ticks, degrees turned, average gain, sync and direction.
- **Mouse-terms advice:** the optimal yaw speed converted into mouse movement, for example "strafe 1 needs about 4.1 cm, you did 6.0 cm".
  - It uses `sensitivity` and `m_yaw` from `config.cfg`.
  - You type your mouse DPI in once, in the settings.
- **Top-down path:** a small view of the path from above, coloured by gain. Clicking a point jumps to that tick.
  - The path is built up from velocity and resets on teleport.
  - The shape is right but not exact down to the unit, which is accepted.

#### Top-down path v1 (2026-10-28)

- **Place:** its own section under the graph (after Missed ticks and the tick axis), above Mistakes (owner's pick).
- **Position:** `buildPath()` in `static/data.js`. Velocity times the tick interval, a row after missed ticks counts for all of them. The timer start is (0, 0) and the rows before it are worked out backwards. A teleport (speed 100+ to standstill or back in one tick, the same rule as `findJumps()`) breaks the line; after it the path restarts at (0, 0), and rows before the last teleport ahead of the timer start (a replay's previous run) get no position.
- **Drawing:** fits the ticks shown in the graph and dims the rest; a "Whole path" toggle (localStorage) fits everything. Colour = gain % of ideal over 5 ticks, same scale as the drill page and in-game line (red 60 %, green 95 %), grey on the ground. Takeoff dots with jump numbers (up to 40 shown), rings for the timer start and the run end, a scale bar in units. The picked mistake is outlined in red on the path too.
- **Linking:** hovering the graph puts a dot (with a short line in the view direction) on the path; hovering the path moves the graph cursor and readout; clicking the path zooms the graph to that jump, or centres it on that tick when it's on the ground.
- **Check:** `node viewer/check_path.js [--list]`: the timer start is at (0, 0) and every row after it has a position (227 attempts, 0 bad). The 5 own bhop_ambience finishes end within 171 units of their mean, so the integration doesn't drift much.
- **Orientation (owner, 2026-10-28):** the path is turned so the way out of the start zone points up (owner: bhop_ambience must look like an inverted U). The first 32 units gave -48 to -90 degrees on own ambience finishes (prestrafe curve, jump-1 turn), so the direction is taken from the timer start to the point 1000 units along the path (or as far as the attempt gets; under 32 units the velocity at the timer start), then snapped to the nearest map axis when within 25 degrees. Over 1000 units ambience runs read -84 to -92, glacial 82 to 109. With the snap every attempt on a map gets the same turn (ambience finish ends 171 units apart). `buildPath()` returns the `turn` so the hover's view-direction line turns with it.
- **Total distance:** horizontal distance from the timer start to the run end (`runEnd()`), plus the distance over the ticks shown in the graph (which can include start-zone and tail rows), in the section head. `pathDistance()` in `data.js`; teleports add nothing. Own bhop_ambience finishes: 17688-18736 units.
- **Zoom and pan (2026-10-28):** + / − / Reset buttons at the top right of the path box (1.5x per click, around the box centre) and drag to pan. Once zoomed or dragged, the path view is frozen in world units (`pathView`) and no longer follows the graph; Reset (or another attempt, or the "Whole path" toggle) goes back to the fit. While frozen, hover and click find any row, dimmed ones too. A drag of more than 4 px doesn't count as a click, so it doesn't zoom the graph. No wheel zoom on the path, so the page still scrolls over it.
- **Gain lanes (owner, 2026-10-28):** the Gain (u/s) lane scales to the ticks in view again (79f7dde had moved every main-page lane to whole-recording scales). Yaw speed scales to the view too (the optimal falls as speed rises, so the slow start's scale squashed late jumps). Speed keeps the whole-recording scale (context; the gain lane shows change within a jump); Angle stays fixed 0-2. The gain line itself is coloured by the 5-tick gain % of ideal (`pathPct()`, red 60 % to green 95 %, same as the path). A separate Gain % lane was tried first and dropped the same day (owner's pick: colour on the same graph). So the colour never clashes, the lost-gain shading is neutral grey and the ideal line light grey, not red and green. The readout has a "gain %" field.
- **Pre-teleport rows dropped (2026-10-28):** `parse()` now drops every row before the last teleport ahead of the timer start (a replay's previous run, which showed as a chunk before -1.5 s) and moves `preRows` with them; it rewrites `a.rows` so a second parse is a no-op. All checkers give the same results as before.
- **Long missed-tick holes (2026-10-28):** a step over more than 5 missed ticks (`PATH_MAX_GAP`) is not drawn on the path; the position still moves on. The player C ambience replay lost 115 ticks after jump 25 when the replay stopped, which drew a 1460-unit straight line.
- **Run end (2026-10-28):** the main page's end index is `runEnd()` (also capped by `runTime`), not just the row before the post tail. A replay pauses at its end and keeps sending rows with the last velocity, so the path ran on past the end (player C's ambience replay went on about 1700 units). Those rows get no path position, sit in the post-end shading, and the checks skip them; the "end" ring sits at `runEnd()`.
- **Paths for comparisons (owner's pick 2026-10-28), built the same day:**
  - **Shared:** `recordingPath()` in `data.js` builds a recording's path with its colour and cuts it at the run end. It always uses the recording's own rows, never the aligned copy: `alignGhost()` rewrites `gap`, which `buildPath()` reads for step lengths, teleports and holes. `pathPct()` moved from app.js to data.js with it.
  - **One frame:** `turnPath()` turns an overlaid path like the reference's (the open attempt on the main page, the first pick on /compare). Paths are built from world velocities with the timer start at (0, 0), so this lines them up exactly. Each path's own snapped turn would not: on own ambience 26 of 135 attempts snap to another turn than the usual 180° (mostly short drills, whose first 1000 units curve).
  - **Main page:** the Compare recording is a pink line under the open attempt (pink shades, not red-green: see below), with a "ghost finish"/"ghost end" ring and its distance in the section head. Its rows count as in view when their aligned tick is in the graph's ticks (all with "Whole path"); rows the per-jump alignment squeezed out have no tick and are drawn dimmed. The fit covers both paths. Hovering puts a pink dot with a view line at the ghost row `ghostNearest()` pairs with the hovered row. Hovering the path finds only the open attempt's rows, as before.
  - **/compare page:** a "Path from above" section under the graph, with every shown recording in its colour and the reference on top. The reference has numbered takeoff dots. Every run end gets a ring, and each recording's distance is in the head. Rows after the run end are not drawn. Fit, dimming, zoom/pan/Reset and "Whole path" work as on the main page. The "Whole path" choice is shared with the main page through the same localStorage key. The graph cursor puts a dot on every path. Hovering the path finds the nearest row of any recording, as long as the row has a graph tick, and moves the graph cursor there. Clicking zooms the graph to that jump in every recording, or centres the graph on that tick when the row is on the ground.
  - **Check:** `check_path.js` turns each attempt to its map's most common turn. Its velocity at the timer start must then point within 45° of up. This uses the velocity because a short drill's path curves. Result: 0 of 26 off on ambience, and 2 of 8 off on glacial. Those 2 are drills that really leave the zone sideways at about 56 u/s. The check also does a `turnPath()` round trip. Screenshot check on both pages, with the hover drawn.
  - **Gain colour and numbers on comparisons (owner, 2026-10-28):** the main page's ghost line is coloured by its 5-tick gain % in pink, from dark (45 % of the colour, 60 % gain and under) to bright (mixed 35 % toward white, 95 % and over): `gainShade()` in data.js. It is solid on the path (owner: the gain is very hard to tell on a dashed line; the graph ghost stays dashed), and it gets pink numbered takeoff dots with the numbers on the left (the open attempt's are on the right). On /compare (owner's pick: one focused and one comparison at a time, the rest plain), Focus / Compare buttons per recording sit above the path. The focus is red-green with white numbers on the right; the comparison shades its own colour like the ghost, with numbers in that colour on the left; the others are thin plain lines. Defaults: the reference is the focus and the second pick the comparison. Picking the other role's recording swaps the two, and clicking Compare again turns the comparison off.
  - Not done: start-zone offsets (plain overlay looks right on own ambience finishes).

### Organising

- **Notes and tags** per attempt (for example "new sens"), with a filter by tag.
- **Filters** by map, tickrate, style (normal, sideways, HSW) and finished or failed.
- **PNG export** of a graph or jump view.
- **Sort and search in the recording lists (owner, 2026-10-28):** on both the main page's sidebar list and the /compare picker list, own runs and replays alike.
  - Sort: for example newest first, time, jump-1 gain, player name. Kept in localStorage.
  - Search: a text box matching player name, map, tags and note. It stacks with the existing filters.
  - Built 2026-10-28, see "List sort and search v1".

#### Notes, tags and filters v1 (2026-10-28)

- **Storage:** `<store>/meta.json` = `{"version": 1, "attempts": {"<map dir>/<id>": {"note", "tags"}}}`. The attempt files stay untouched (the collector owns them, and the server caches their heads by mtime and size). An attempt with no note and no tags has no entry. A deleted attempt's entry stays behind, which does no harm.
- **Server:** `/api/attempts` merges `note` (`""`) and `tags` (`[]`) into a copy of each head, so the drill and compare pages get them too. `POST /api/meta/<map>/<id>` with `{"note", "tags"}` stores them and answers with what was stored.
  - Trimming: the note to 2000 characters, each tag to 40, at most 20 tags. Spaces are collapsed and tags are deduped ignoring case.
  - Writes go through a lock, a temp file and a rename.
  - A POST is refused (403) unless it is `application/json` with a Host (and Origin, if sent) of 127.0.0.1 or localhost on the viewer's port. Without this, any web page could send a plain-text POST to localhost.
  - Bodies over 16 KiB get 413. A POST for an attempt with no file gets 404.
- **Main page:** a row under the header holds:
  - tag chips with × to remove
  - an "Add tag" box (Enter; old tags offered as suggestions)
  - a note box (saves on Enter or when clicking away; Esc undoes)

  The row sits outside `#head`, so a live list refresh never wipes what is being typed. List items show the tags and the note's first line.
  - Saves go out one at a time, in order. Each edit is applied to the list at once, so a second edit made while the first is still being saved builds on it instead of undoing it (tested: note change + tag × back to back give one body with both).
  - A new tag that another attempt already has, ignoring case, takes that spelling, so the tag filter finds both.
  - The list keeps its scroll position when it is rebuilt.
- **Filters** (sidebar, under "Show drills"): map, tickrate, style (Momentum's style names; half-sideways is 1 = bhop, 2 = surf), result (finished / not finished) and tag.
  - Each select lists only values the saved attempts have. A choice is greyed out when, given the other filters, the search and "Show drills", it would list nothing or the same attempts as All. A select with no such choice left is greyed out whole, unless going back to All would change the list (owner's pick 2026-10-28; replaced "greyed out with a single value").
  - Choices are saved in localStorage `strafe-review-filters`.
  - The filters stack with "Show drills" and the replay-fragment rule. "N of M shown" also counts matching drills that the drill toggle hides.
  - The open attempt stays listed when it is a hidden drill, not when the filters leave it out (owner 2026-10-28). On load, the first listed attempt opens.
- **Checks:** server round trip on a scratch store (save, dedupe, 403 for text/plain, foreign Origin and foreign Host, 404, 413, clearing). Screenshot check with stubbed fetch and EventSource and a faked second style.
- **Automatic tags** (`static/autotags.js`, owner's picks 2026-10-28). They are worked out in the page from the heads and never stored. Own attempts only.
  - Shown as dashed chips with no ×. An auto-tag that the attempt also has as an own tag is shown only once, as the own one.
  - They work in every tag filter.
  - **new sens:** attempts at a sens never used before, for 24 h from the first one, until the sens changes again.
    - A sens is sensitivity, m_yaw and Momentum's stored DPI. An attempt with no stored DPI keeps the one before it.
    - The first stamped sens is the baseline and gets no tag.
    - Attempts from before the recorder stamped `mouse` (2026-10-27) have no sens, so they get no sens tags.
  - **old sens:** going back to a sens used before. Tagged for 24 h only if at least 75 attempts at other sens values came in between. A short trial and back gets nothing.
    - The owner raised the noise problem and picked 75.
    - The number is "Old sens after N attempts away" in the main page's check settings (localStorage `strafe-review-autotags`).
  - **PB:** a finish faster than every earlier own finish on the same map, tickrate, style and track. Practice runs are skipped, and the first finish counts.
  - Check: `node viewer/check_autotags.js` runs hand-made cases, then the tags the saved attempts get (189 attempts: 3 PBs on bhop_ambience, no sens stamped yet).
- **Drill page tag filter:** a Tag select in the bar holds own and automatic tags of own attempts on the picked map. Only attempts with the tag are counted, and the "Latest session" scope is applied after the filter. Replays are not filtered. The choice is kept in localStorage `strafe-review-drill-tag`. Bulk tagging was offered and not wanted.

#### List sort and search v1 (2026-10-28)

- **Shared code:** `static/listsort.js`, loaded by the main page and /compare (/compare now also loads `autotags.js`, so automatic tags are searchable there too). The drill page is unchanged.
- **Sorts:** newest first, oldest first, fastest finish (finished runs by time, then the rest), jump 1 landing speed (`j1Land`), jump 1 speed gained (`j1Land - j1Takeoff`), player name (replays and spectated, case ignored). The two jump-1 orders differ on real heads (zone takeoff varies by about 7 u/s), so both are offered. A recording without the value goes last in every sort; ties go newest first.
- **Search:** case-ignored, every word must appear in the player, the label (Own run / Replay / Spectated), map, own or automatic tags, or the note. Not kept across reloads, so a forgotten search can't hide recordings.
- **Main page:** search and sort sit at the top of the sidebar filters. The search counts as a filter ("N of M shown", the drill count, Clear filters, which also empties it). Sorting happens inside each map group; the groups keep their order (newest attempt's map first). "Fastest finish" needs the Map filter on one map (owner, 2026-10-28: on All it put one glacial replay at the top and the ambience finishes far down); on All it is greyed out and the list sorts newest first, and the saved choice comes back when a map is picked. A sort that orders the listed attempts the same as one above it in the menu is greyed out as "(same as …)", e.g. Fastest finish with Tag on PB (owner, 2026-10-28). On load the newest listed attempt still opens, whatever the sort. Sort kept in localStorage `strafe-review-sort`.
- **/compare:** search box and Sort select in the Recordings header. Picked recordings stay listed even when the search would hide them. Quick picks are unaffected. Sort kept in `strafe-review-compare-sort`.
- **Check:** `node viewer/check_listsort.js [--url http://127.0.0.1:8765]`: hand-made cases (order per sort, missing values last, ties, search words ANDed over tag, auto tag, note, player, label), then every sort on the running viewer's heads (265: missing values all last) and a search for a real auto tag.

#### Replay finishes (2026-10-28)

- **Problem (owner):** player A's bhop_glacial replay played to the end but never counted as finished. No replay ever did: all ended `replaced`.
- **Why:** when a replay reaches its end and loops, Momentum fires `OnObservedTimerReplaced` one tick before the observed timer would read FINISHED. The recorder ends the attempt there. Every full replay stopped exactly one tick (0.01 s) before the run time in its replay file (player A 32.555 vs 32.565 s, player F 32.765 vs 32.775 s, all 7 full ambience replays the same).
- **Fix (server, owner's pick over a recorder change):** `replay_finished()` in head() reads the run time from the replay's `.mtv` header (`replayFile`, relative to the Momentum folder next to `--game-cfg`). A `replay` head that ended `replaced` within 2 ticks of it becomes `reason: finish` with `runTime` = the file's time; the recorded end is kept in `recordedRunTime`. Old recordings are fixed too; nothing in the attempt files changes.
- **Header layout** (worked out from saved online replays, formats 1 and 2 alike): `MMTV`, int32 version, int64 date, map name [64], map hash [41], uint16, float tick interval at 0x7b, uint64 SteamID, player name [33], one byte, run time as a double at 0xa9. Checked by the magic, version 1 or 2 and the interval matching the attempt; otherwise the head is left alone.
- **Result on the store:** 9 replays become finishes; stopped ones (player C at 5.9 s, player D and player E at 0 s) stay "Replay stopped". Spectated live players are untouched.
- Needs a viewer restart (server.py change).

#### Run stats v1 (2026-10-28)

- **Owner's call.** The swap display (to-do `strafe-review-swap-display`) became part of a whole-run stats section above the main page's graph: "every possible stat that is useful" over the whole run. Per-jump detail stays in the graphs, so there is no per-jump table here.
- **Where.** `#run-stats` sits between the tags/note row and the toolbar, so toolbar, readout and graph stay together (Claude's placement). Cards: Run, Gain, Speed (with jump 1), Turning, Swaps, Keys, Mistakes. Hovering a stat row shows a tip at once: a plain-words description, then the exact definition (owner: descriptions under each stat were too wordy, 2026-10-28). Best jump, worst jump, worst swap and jump 1 gain are clickable and zoom the graph there. With a Compare recording, its value sits next to each one in pink (not for mistakes).
- **Code.** Everything is in `summarize()` (stats.js), so the compare page can show the same numbers later. `swapsOf()` there does the swaps. `node viewer/check_stats.js` prints them after the `|`. Older fields print unchanged (diffed before and after).
- **Gating.** Spectated live runs (`d.coarse`) show only run, gain % per jump and speed numbers. Other players' recordings leave out the key rows (switch, no key, W in air), and their sync is marked approx.
- **Swap definitions** (`swapsOf()`):
  - A swap is two strafes in a row inside a jump (`strafesOf()`). It is skipped when there are missed ticks within 12 ticks of the reversal; elsewhere in the strafe they don't matter (one run has a missed tick in almost every strafe).
  - The reversal is the first row from 4 ticks before the new strafe's start where the raw per-tick yaw turns the new way. The 5-tick average smears it.
  - Time: from the last old-side tick at 85 %+ of optimal (raw yaw) to the first new-side one.
  - Efficiency / lost: gain over ideal on the 7 rows centred on the reversal. For other players' recordings the window is centred `lag` rows earlier (keyLag(), 5-7 on replays). Gain % by tick offset from the angle reversal dips at 0 on own runs (6 % at the reversal) but at -6 on replays (33 %): replay view angles trail the velocity by about the key lag. v1 missed this and showed replays at 99 % (owner spotted it, 2026-10-28).
  - Peak: the fastest 2-tick average of the new-side turn in the 6 ticks after the reversal, vs optimal. Over 1.15 is overshoot, under 0.85 undershoot. It is not judged when +left/+right is held. Those swaps stay in time and efficiency, and the worst swap says "(+left/right)".
  - Gain dip (owner asked 2026-10-28: how fast the slowdown, pause and recovery happen, in gain terms): the lowest per-tick gain % within 4 ticks of the efficiency window's centre, then the ticks in a row below the run's own gain % before it (down) and after it (up); dip = down + 1 + up. The threshold is the run's gain % (owner's pick over a fixed 85 %). Shown as averages over the swaps (owner's pick 2026-10-28, after separate medians read like "2 t, 0 down, 0 up"): down + low + up = total, low = share of swaps with a dip at all. Averages run higher than medians (one finished run: 8.2 vs 5). Dip low point = that lowest tick's gain % (median). Measured: own dip median 4 ticks (finished ambience runs 4-5.5, low point about 0 %), replays 1-2 (low point 17-39 % on top replays).
  - Swap vs strafe gain (owner's pick 2026-10-28, over averaging the strafes either side of a swap, which comes out at about the run's own gain % because each strafe touches two swaps): gain % pooled over all 7-row swap windows (each row once, same centre as Efficiency) vs over the strafing rows outside every window, and the gap in points. Windows of gap swaps are left out of both. Measured: own finished runs about 45-58 % vs 85-95 % (gap about -40 pts), top replay 88.6 vs 98.6 % (-10).
  - Key switch: the switch check's own rule (nearest switch within `SWITCH_WINDOW`, offset from the new strafe's start, target -1; none when either strafe has missed ticks). On target = 0-2 ticks before. Early / late use the switch check's thresholds from Check settings, so the counts equal the Mistakes list's switch entries (220 of 220 own attempts at defaults).
  - A swap with missed ticks near the reversal keeps only its key switch (`gap: true`) and isn't in the Swaps count.
- **Measured over the store with the shipped `swapsOf()` (2026-10-28):**
  - Own swaps (2035): median time 8 ticks (4 down + 4 up), efficiency 54 % (quartiles 36-63), peak 0.91. Under 0.85: 763 of 2011; over 1.15: 224.
  - Replays (303): time 4 (2 + 2), efficiency 84 % (quartiles 71-89) after the lag shift, peak 1.04. Swaps hold 59-83 % of a top replay's speed lost too.
  - Away from swaps both gain about 91-98 % per tick. Speed-derived gain gives the same 54 % on own runs.
  - On the owner's finished ambience runs, swaps hold 50-64 % of all speed lost (one run with missed ticks near most swaps: 4 %).
- Other new numbers: speed lost (sum of ideal - gain on strafing ticks), spread (std dev of landed jumps' gain %), left/right gain %, band shares (in / too slow / too fast, yawRatio 0.85-1.15 on strafe middles), median turn speed (+ cm/s with the DPI), strafe length, +left/+right ticks, air time, no key while turning, W in air, distance.

#### CS:S gain (SSJ) v1 (2026-10-28)

- **Owner's ask.** A tool that turns Momentum gain into CS:S gain and back. A single number can't be converted, because the two measure different things, so each jump gets a CS:S-style gain computed from the recording instead. It shows in the jump strip label, the Run stats Gain card (whole run, plus jump 1 in the Speed card), on /drill next to jump 1's gain, and in the /compare stats and per-jump tables.
- **Source.** The SSJ plugin, Nairdaa/shavit-ssj (`SSJ_GetStats`). It runs on every tick of a jump: the jump tick (ground, jump pressed) and each air tick, unless on a ladder or in water. wishdir comes from the command's angles and forwardmove/sidemove. currentgain = velocity (before the move) · wishdir. The tick scores (wishspd - |currentgain|) / wishspd when currentgain < 30 (wishspd = min(wishspeed, 30), so 30 with any key), else 0. With no key it counts as a synced, perfect tick (score 1; the real-server check below showed this, an earlier reading of the code said 0). The jump's value is sum / ticks * 100, printed on the next jump's chat line. A wall-touch rule flips scores over 0.5; it is left out here, because there is no wall data. The formula was re-implemented from reading; no code was copied.
- **How (data.js `ssjOver()`, `angleFit()`, `wishDir()`).**
  - Air rows come from the velocity alone. The air move adds (30 - p) along wishdir, so m = |v - v_prev| (horizontal vector) gives p = 30 - m exactly. Score: m / 30 up to 30, (60 - m) / 30 above. Rows with m > 60 count only when Δv lines up with the yaw + keys wishdir within 5°. That is turning far ahead of the velocity, which SSJ scores negative; 529 of 781 such own-run rows out of 74k. Other rows over 60 are a teleport, booster or wall, so they're skipped.
  - Which ticks: SSJ prints on the next jump (Player_Jump, after OnPlayerRunCmd has scored that jump's takeoff tick), so a line holds a jump's air rows after takeoff, its landing row (the move starts in the air) and the next jump's takeoff row (when within 10 rows). The viewer's jump N is SSJ's chat line `J: N+1` if SSJ numbers jumps as the viewer does; `J: 1` only shows the prestrafe.
  - Why not the yaw: the recorded yaw is a per-frame sample up to about 1.3° off the real move direction, measured as the angle between wishdir and the actual velocity change. At 1000 u/s 1° moves p by about 17. The yaw method put top replays at 52-67 % and one at -300 %. The velocity method gives 79-88 %.
  - The takeoff row is a ground move, so it uses yaw + keys, read `lag` rows later. `angleFit()` picks the offset 0-10 whose angles best predict each air tick's speed with CS:S air physics (own runs: lag 0, error 0.03 u/s; replays: lag 6). A fit worse than 1 u/s leaves the takeoff row out.
  - Spectated live runs (`d.coarse`) get none.
- **Check.** The CS:S air physics (add up to 30 u/s along wishdir) predicts own-run speed per tick to 0.03 u/s, so Momentum's air move matches CS:S here. Old summary stats were unchanged by this.
- **Numbers.** Owner's finished ambience runs: 71-77 % CS:S (with the no-key rule) vs 83-88 % Momentum gain. Top replays: 79-88 % CS:S vs 91-95 %. The two don't map one to one: CS:S scores the angle error linearly, Momentum's speed gain only quadratically.
- Run time over the whole store (240 attempts): about 1 s, so `angleFit()` on every page load is fine.
- **Owner test (2026-10-28, owner's pick):** the recorder now also saves `wx`, `wy` = `GetMoveHudData().wishVel` x/y (the game's own wish velocity, as the cgaz HUD uses it), appended to the end of the columns so old files still parse. `node viewer/check_ssj.js` compares, per air row, p from wishVel with p from the velocity change at wishVel row offsets -1/0/+1, and the per-jump SSJ % both ways. Checked on a fake file with wishVel made from the velocity change: median p difference 0.1 at offset 0, jumps within 0.3 %. Waits on the owner: `panorama_reload`, some runs including deliberately over-turned jumps at high speed, then run the checker.
- **Owner test result (2026-10-28, 4 bhop_glacial attempts, about 3000 air rows, many over-turned):** wishVel at row offset 0 matches p from the velocity change to a median 0.006 u/s (p90 0.015). The air-row formula is confirmed, over-turned moves included. Two defects found and fixed:
  - A zone reset that zeroed the velocity (40 to 0 u/s, Δv under 60) was scored as an air move. A row whose velocity drops to a standstill (Δv over 5, speed under 0.5) is now skipped.
  - Takeoff rows came from the angles (up to 1 pt per jump off), and with a poor angle fit (err over 1) over-turned rows with Δv over 60 were dropped because their direction couldn't be confirmed. One attempt's jump 1: 35.73 % before, 25.04 % with them.
  - Fix: `ssjRow()` uses the recorded wishVel direction for every row when the recording has `wx`/`wy` (velocity guards kept). Recordings without it use the old velocity + angle method. Now every jump of the 4 attempts equals the wishVel computation to 2 decimals. One wall touch (speed 30 to 30, direction flipped) now scores 0 instead of 0.41.
- **Real CS:S server check (2026-10-28).** The owner recorded a client demo (`record`) on a public 100-tick bhop server running SSJ, bhop_ambience, 36 jumps incl. over-turned and no-key jumps, and copied the console's [SSJ] lines. Demo and console text stay out of git (server address, names).
  - `viewer/css_demo.py DEMO OUT.json` turns the demo into a recording: origin per packet (one server tick each, in file order: the frames' tick labels jitter with the frame rate), commands per tick (delta-coded CUserCmd), packet k = command k - 2 (fitted with CS:S air physics: median error 0.004 u/s), stalled packets rebuilt. `node viewer/check_css_ssj.js OUT.json CONSOLE.txt` runs the shipped findJumps()/ssjJump() and pairs jumps with SSJ lines by takeoff speed.
  - Two rules corrected: a tick with no movement key scores 1 (synced), not 0 (one no-key jump: SSJ 97.47 %, the old rule gave 16 %); and when the landing tick is the next jump's tick (CS:S, no ground row between) that row was counted twice. Momentum always has a ground row, so the second fix doesn't change Momentum numbers; the first raises the owner's finished ambience runs by 1.3-1.7 pts (69.6-75.4 % to 71.3-76.8 %).
  - Result: 31 of 33 jumps equal SSJ to 0.01 with the wish velocity (SSJ cuts to 2 decimals). The 2 misses are the fall at the end, with wall contact: SSJ's wall-touch rule isn't modelled. Without wishVel (velocity + angles, for older Momentum files) 30 of 33 when the angle fit is good; this demo's teleports break the fit (err 133), which drops it to 20.
  - Tick set, measured: a line holds the air ticks after takeoff and the tick the player lands and jumps again on (74-75 ticks per jump at 100 tick, matching SSJ's sync counts). Momentum's equivalent is the air rows, the vz-0 landing row and the next takeoff row, as before.
  - Guards (whole-store check after the no-key rule): replay keys run ahead of the moves (their "no key" rows have a median air move of 26-32 u/s) and spectated runs carry the owner's idle keys, so the no-key rule only applies to own, non-coarse runs (`d.ownKeys`); replays and spectated runs keep the old numbers (top replays still 79-88 %). wishVel is used only if the recording has non-zero wish in the air (`d.hasWish`); no replay or spectated recording with wishVel exists yet, so whether wishVel is valid while spectating is untested. Own attempts change by a median of 6 pts, mostly drills where keys are let go after a fail (SSJ scores those ticks as perfect too).
  - Other servers: treated as settled (owner, 2026-10-28: SSJ stats shouldn't differ between CS:S servers). 66 tick is out of scope for CS:S gain (owner, 2026-10-28: 66-tick bhop CS:S gain doesn't matter).

## Next: fixes before the CS:S gain test (owner, 2026-10-28, somewhat urgent)

Do these before the owner's SSJ wishVel test (to-do `strafe-review-ssj-test`).

1. **Done (2026-10-28): graph readout overflow.** `#main` is a scrolling flex column, so `#readout` (min-height 30 px) shrank and its wrapped values spilled out. Now `flex: none`, and `holdHeight()` (data.js) keeps both pages' readouts at the tallest height seen for the width (and, on /compare, the number of recordings), so the graph doesn't jump while hovering. Same pass: /compare's picker columns shrink with ellipsis in narrow windows ("Make reference" was cut off), and dark scrollbars (`color-scheme`, `scrollbar-color` in style.css).
2. **Done (2026-10-28): comparison removed from the main run page.** Picker, align select and hint, ghost chips, lane ghost, jump-strip ghost, pink path, hover ghost values and the pink Run stats column are gone. The "Compare page" button opens /compare with the open attempt as the reference. `alignGhost()`, `ghostNearest()`, `turnPath()` and `gainShade()` stay in data.js for /compare.
3. **Done (2026-10-28): /compare has everything the main page compared.**
   - Run stats rows live in `static/runrows.js`, loaded by both pages: same rows, descriptions and hover tips. /compare shows one column per recording and stars the best per row. Direction per row: `best` is 'max', 'min' or a target (angle and peak 1, switch vs reversal -1). Not ranked: jumps landed, missed ticks, best/worst jump, turn speed, strafes per jump, strafe length, +left/+right ticks, swaps, key lag, worst swap. Run-length sums (distance, speed lost, speed at the end, end time) rank finished runs only. Rows a recording can't have (keys on replays, tick rows on spectated runs) show '–' with the reason.
   - Clickable cells (best/worst jump, jump 1 gain, worst swap) zoom the compare graph; worst swap uses that recording's aligned x.
   - Quick picks above the recording list: your fastest finish, your best jump 1, top replay. Click adds, click again takes out.
   - The legend says when a recording's gain and angle were rebuilt from speed.
   - Not ported: the ghost's thin A/D key strips. /compare has no keys lane.
4. **Done (2026-10-28): end chip pushed out of the attempt card.** A long label such as `Replay: Soulmanyes. #BOTDG` pushed the end chip past the card's edge. The card's first row now wraps (the end chip drops under the label), and a chip longer than the card ends in an ellipsis.

#### Bonus tracks and 66 tick v1 (2026-10-28)

Owner's scope: bhop bonuses on surf maps (66 tick), not surfing itself.

- **Course = map + track.** `course(h)` in data.js: the map folder for the main track, `<map>: bN` for bonus N (`sN` for stage N; owner's format), from the recorder's `track` (`{type: 0 main / 1 stage / 2 bonus, number}`, Momentum's TrackType). Old files without a track are main. Storage folders and meta.json keys (`<dir>/<id>`) stay per map.
  - Keyed on course: the main page's Map filter (one entry per course), list groups, "Fastest finish needs one map", the jump-1 takeoff baseline; /compare's map picker, picks and quick picks; /drill's map picker and baseline; `check_mistakes.js`. Autotags' PB already keyed on track. The attempt header shows the course.
- **Tick label:** `tickRate()` names 0.015 s as 66 tick (`Math.round` said 67). Time labels on the graph axis and readout use `tick × interval`, not `tick / tps`.
- **Timing checks scale with tickrate:** early reversal, late first strafe, wrong key, no key and W in air are tick counts at 100 tick (settings labels say so), turned into the same time at the attempt's tickrate, rounded up (66 tick: early 18 -> 12, late first 3 -> 2, wrong key 2 -> 2, no key 3 -> 2, W in air 5 -> 4). Switch offsets and `SWITCH_WINDOW` stay in ticks (target "one tick before the reversal" at any tickrate); so do the smoothing windows and skip counts. Same in the recorder's in-game line (`atRate()`); `parse()` now carries `d.interval`.
  - Check: `node viewer/check_line.js --interval 0.015` replays every own attempt as if at 66 tick through both the recorder and the viewer (211/211 same; 8 attempts lose an early-reversal flag vs 100 tick).
  - `check_line.js --log` can show DIFFs for 66-tick lines logged before the recorder got `atRate()` (surf_artois Bonus 1 runs of 2026-10-28): those were judged with 100-tick counts. Not a bug.
- **Physics at 66 tick:** the 30 u/s air add holds (own surf_artois Bonus 1 finish: 1254 air rows, none above ideal). Own bonus finishes: 18.75 s and 19.37 s, 84 % gain, 22-23 jumps landed. SSJ is shown at 66 tick too, not checked against a server (66-tick CS:S gain out of scope, see above).

## Later / undecided

- **Surf main tracks (real surfing):** not wanted (owner, 2026-10-28: "actual surfing doesn't need this, just bhop bonuses within surf"). Replays and spectates of surf runs still get saved and shown with the bhop analysis (ramps read as air, so gain and checks are meaningless there). Nothing is built for it.
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
