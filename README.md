# Strafe Review

Per-tick strafe recording and review for Momentum Mod. A custom HUD script records each attempt, and a local web page shows every jump as a graph, lists the mistakes found, and compares your strafing with optimal movement and with replays.

Status: recorder, collector and viewer work. The viewer has three pages:

- `/`: one attempt as a zoomable graph, with run stats and the mistakes found. "Compare page" opens it on /compare.
- `/drill`: jump 1 of every attempt, stacked and side by side, updated live, with each strafe's mouse movement in cm next to the optimal (type your mouse DPI in once).
- `/compare`: 2 to 4 recordings on one graph, with every run stat side by side (best per row marked), per jump numbers and mistakes. Quick picks: your fastest finish, your best jump 1, top replay.

In game, the recorder shows a 3-row line after jump 1 lands: landing speed, gain % per strafe and the biggest mistake.

Next: top-down path, notes/tags/filters, PNG export. See [PLAN.md](PLAN.md) and the feature plan doc with drawings:
(link removed)

## Setup (so far)

1. `recorder/install.sh` copies the recorder HUD script into Momentum's `custom/` folder. Type `panorama_reload` in game after updating it.
2. `collector/install.sh` links `strafe-review-run` into `~/.local/bin`.
3. Set Momentum Mod's Steam launch options to `strafe-review-run sourceyaw-run %command%`. Attempts are saved to `~/.local/share/strafe-review/attempts/<map>/`.
4. `python viewer/server.py` serves the review page on http://127.0.0.1:8765/ (`--port` to change it).

License: CC0 1.0 (see [LICENSE](LICENSE)).
