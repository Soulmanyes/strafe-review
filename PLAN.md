# Strafe Review: plan

Status: planning only. Nothing is built yet.

## Goal

Review strafing per jump after a Momentum Mod run ends, failed or finished. The main problem to solve is bad gain on the first jump (from leaving the start zone to the first landing), but the whole run should be reviewable.

Momentum's built-in JSS/gain HUD is hard to read mid-run and has no history once the run is over. This tool records every tick and shows it afterwards outside the game, in a local web page, at any resolution and on any monitor.

Scope: Momentum Mod only for now. CS:S has no Panorama HUD, so a CS:S version would need input-based simulation instead (see "Later").

## Architecture

1. **Recorder (inside Momentum).** An invisible custom Panorama HUD script, loaded from `momentum/custom/<folder>/`.
   - It buffers every tick of the attempt. When the attempt ends, it writes the run out in compact chunks with `$.Msg`.
   - Panorama output ends up in the console log (`con_logfile`, already used by Source Yaw as `yaw.log`).
   - Chunked output avoids printing to the console every tick, which could stutter.
2. **Collector (Source Yaw).** Tails `yaw.log`, puts the chunks back together, and saves each attempt to disk as a compressed file. Source Yaw already tails this log.
3. **Viewer (local web page).** Served on localhost by Source Yaw. It reads the saved attempts and shows the graphs.

A HUD that only reads and displays data is normal in Momentum; HUD customisation is common there. The recorder never sends inputs.

## Facts checked (2026-10-25)

- **Custom files load first.** `gameinfo.txt` mounts `momentum/custom/*` first as `game+mod`, so files there override the game's own.
- **Scripts compile at runtime.** `panorama.so` contains the TypeScript transpiler, so `.ts` HUD scripts are compiled when the game loads them.
- **Where HUD panels are defined.** HUD children are listed in `panorama/layout/hud/hud.xml` and registered in `panorama/scripts/util/panel-registration.ts`. The lightest hook is probably overriding one small existing HUD script, not the whole of `hud.xml`, which would hide future upstream changes to that file.
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
- **Frames vs ticks.** HUD scripts run once per frame, not once per tick:
  - Ticks are deduplicated by game time.
  - Ticks missed because fps dropped below the tickrate are stored as gaps, never filled in.
- **Tickrate.** Momentum surf maps run at 66 ticks per second and bhop maps at 100. Store the tick interval with every attempt.
- **Labels.** Every recording is labelled as one of: your own run, someone else's replay, or a ghost. The label is shown everywhere it appears.
- **Retention.** Every attempt is kept, compressed. The viewer has a manual "delete older than" button.
  - Rough size: about 40 bytes per tick, so roughly 12 KB for a 3-second failed first jump.
  - Keep the file format stable, because the progress view reads old attempts.

## Viewer

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
