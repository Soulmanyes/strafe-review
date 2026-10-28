# Strafe Review

Per-tick strafe recording and review for Momentum Mod. A custom HUD script records each attempt, and a local web page shows every jump as a graph, lists the mistakes found, and compares your strafing with optimal movement and with replays.

Status: recorder, collector and viewer work. The viewer has three pages:

- `/`: one attempt as a zoomable graph, with run stats (including CS:S-style SSJ gain), the mistakes found and a top-down path. Attempts take notes and tags; automatic tags mark PBs and sens changes. The list filters by map, tickrate, style, result and tag, has a search box, and sorts by date, fastest finish, jump 1 speed or player. "Compare page" opens it on /compare.
- `/drill`: jump 1 of every attempt, stacked and side by side, updated live, with each strafe's mouse movement in cm next to the optimal (type your mouse DPI in once).
- `/compare`: 2 to 4 recordings on one graph, with every run stat side by side (best per row marked), per jump numbers, mistakes and paths. The picker has the same search and sort. Quick picks: your fastest finish, your best jump 1, top replay.

In game, the recorder shows a 3-row line after jump 1 lands: landing speed, gain % per strafe and the biggest mistake.

Replays played to the end count as finishes. Bonus tracks are recorded and listed per bonus ("surf_artois: b1"), and 66-tick bhop works next to 66-tick surf.

Run stats, graphs and paths on `/` and `/compare` each have Copy and Save buttons: Copy puts a picture of that section on the clipboard, Save downloads it as a PNG.

Next: progress over time, tuning the check thresholds. See [PLAN.md](PLAN.md) and the feature plan doc with drawings:
(link removed)

## Setup on Linux (so far)

1. `python install.py` finds Momentum through Steam's library folders (or `MOMENTUM_DIR`, or `--game DIR`) and:
   - copies the recorder HUD script into Momentum's `custom/0-strafe-review` folder, with a `timer.xml` that loads it: a copy of the one the game would load otherwise (another HUD mod's in `custom/`, else the game's own) plus one script line. The folder name sorts first, because the game mounts `custom/` folders alphabetically and the first file found wins. Type `panorama_reload` in game after updating it,
   - adds a marked block to `cfg/autoexec.cfg` (`con_logfile yaw.log`, and `engine_no_focus_sleep 0` so replays watched while tabbed out record every tick; the first run keeps a copy as `autoexec.cfg.bak-strafe-review`; restart the game after installing),
   - on Linux, links `strafe-review-run` into `~/.local/bin`.

   `python install.py --uninstall` takes all three out again.
2. Keep the repo where it is: the link and the launch option run it from there.
3. Set Momentum Mod's Steam launch options to `strafe-review-run sourceyaw-run %command%`. When the game starts, it starts `viewer/server.py` as the systemd user unit `strafe-review`, which stays running after the game quits (the Stop button on every page ends it, or `systemctl --user stop strafe-review`). When the game quits, the review page opens in the default browser.
4. The server collects attempts from `yaw.log` into `~/.local/share/strafe-review/attempts/<map>/` and serves the review page on http://127.0.0.1:8765/. Started by hand, it opens the page in the default browser: `python viewer/server.py` (`--port` to change the port, `--no-collect` to only serve, `--no-browser` to skip the tab).

## Setup on Windows (untested so far)

1. Unzip `strafe-review-windows.zip` from the release (built by `.github/workflows/windows.yml`; `python build.py` builds `dist/strafe-review.exe` with PyInstaller on a Windows PC).
2. Double-click `strafe-review.exe`. It finds Momentum through Steam, installs or updates the recorder and the `autoexec.cfg` block (as `install.py` does), then collects and opens the review page. Keep its window open while playing; closing it stops collecting, and the next start picks up what was missed from `yaw.log`. A second double-click while it runs only opens the page.
3. Or put it in Momentum Mod's Steam launch options instead: `"C:\path\to\strafe-review.exe" %command%`. It then starts the server in the background with the game and opens the page when the game quits. The server keeps running after that, without a window; the Stop button on the page ends it.
4. Restart the game after the first start, so the `autoexec.cfg` block is read. Attempts are kept in `%LOCALAPPDATA%\strafe-review\attempts`.

## Updates and settings

- The page checks GitHub for a new release every few hours and shows a banner when there is one. The Windows exe installs it with **Update** and starts again; tick **Install updates automatically** (bottom left of the main page) to skip the button. A copy running from this repo only reports new versions: `git pull` brings them.
- **Show the jump-1 line in game** (bottom left of the main page) turns on the in-game line after jump 1: landing speed, gain %, gain per strafe and the biggest mistake. It is off by default so it doesn't land on top of anyone's own HUD. Type `panorama_reload` in the game console after changing it.

License: CC0 1.0 (see [LICENSE](LICENSE)).
