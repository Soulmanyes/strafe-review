# Strafe Review

Per-tick strafe recording and review for Momentum Mod. A custom HUD script records each attempt, and a local web page shows every jump as a graph, lists the mistakes found, and compares your strafing with optimal movement and with replays.

Status: recorder, collector and viewer work. The viewer has three pages:

- `/`: one attempt as a zoomable graph, with run stats (including CS:S-style SSJ gain), the mistakes found and a top-down path. Attempts take notes and tags; automatic tags mark PBs and sens changes. The list filters by map, tickrate, style, result and tag, has a search box, and sorts by date, fastest finish, jump 1 speed or player. "Compare page" opens it on /compare.
- `/drill`: jump 1 of every attempt, stacked and side by side, updated live, with each strafe's mouse movement in cm next to the optimal (type your mouse DPI in once).
- `/compare`: 2 to 4 recordings on one graph, with every run stat side by side (best per row marked), per jump numbers, mistakes and paths. The picker has the same search and sort. Quick picks: your fastest finish, your best jump 1, top replay.

In game, the recorder shows a 3-row line after jump 1 lands: landing speed, gain % per strafe and the biggest mistake.

Replays played to the end count as finishes.

Next: PNG export, progress over time, 66-tick surf and bhop bonuses. See [PLAN.md](PLAN.md) and the feature plan doc with drawings:
(link removed)

## Setup (so far)

1. `recorder/install.sh` copies the recorder HUD script into Momentum's `custom/` folder. Type `panorama_reload` in game after updating it.
2. `collector/install.sh` links `strafe-review-run` into `~/.local/bin`.
3. Set Momentum Mod's Steam launch options to `strafe-review-run sourceyaw-run %command%`. Attempts are saved to `~/.local/share/strafe-review/attempts/<map>/`.
4. `python viewer/server.py` serves the review page on http://127.0.0.1:8765/ (`--port` to change it).

License: CC0 1.0 (see [LICENSE](LICENSE)).
