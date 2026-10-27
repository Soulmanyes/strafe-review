# Strafe Review

Per-tick strafe recording and review for Momentum Mod. A custom HUD script records each attempt, and a local web page shows every jump as a graph, lists the mistakes found, and compares your strafing with optimal movement and with replays.

Status: recorder, collector and viewer work. The viewer has three pages:

- `/`: one attempt as a zoomable graph, with the mistakes found and an optional ghost (your best run, best jump 1, a top replay or any recording you pick).
- `/drill`: jump 1 of every attempt, stacked and side by side, updated live.
- `/compare`: 2 to 4 recordings on one graph, with stats side by side (gain, sync, angle, jump 1, speed, per jump, mistakes).

Next: in-game one-liner, mouse-terms advice, top-down path. See [PLAN.md](PLAN.md) and the feature plan doc with drawings:
(link removed)

## Setup (so far)

1. `recorder/install.sh` copies the recorder HUD script into Momentum's `custom/` folder. Type `panorama_reload` in game after updating it.
2. `collector/install.sh` links `strafe-review-run` into `~/.local/bin`.
3. Set Momentum Mod's Steam launch options to `strafe-review-run sourceyaw-run %command%`. Attempts are saved to `~/.local/share/strafe-review/attempts/<map>/`.
4. `python viewer/server.py` serves the review page on http://127.0.0.1:8765/ (`--port` to change it).

License: CC0 1.0 (see [LICENSE](LICENSE)).
