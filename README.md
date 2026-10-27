# Strafe Review

Per-tick strafe recording and review for Momentum Mod. A custom HUD script records each attempt, and a local web page shows every jump as a graph, lists the mistakes found, and compares your strafing with optimal movement and with replays.

Status: recorder and collector work; the viewer is next. See [PLAN.md](PLAN.md) and the feature plan doc with drawings:
(link removed)

## Setup (so far)

1. `recorder/install.sh` copies the recorder HUD script into Momentum's `custom/` folder. Type `panorama_reload` in game after updating it.
2. `collector/install.sh` links `strafe-review-run` into `~/.local/bin`.
3. Set Momentum Mod's Steam launch options to `strafe-review-run sourceyaw-run %command%`. Attempts are saved to `~/.local/share/strafe-review/attempts/<map>/`.

License: CC0 1.0 (see [LICENSE](LICENSE)).
