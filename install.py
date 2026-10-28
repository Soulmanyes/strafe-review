#!/usr/bin/env python3
"""Installs Strafe Review into Momentum Mod, or takes it out again.

Usage: install.py [--game DIR] [--uninstall]

- Copies the recorder (recorder/panorama) into the game's custom/strafe-review folder. Type
  panorama_reload in game after updating it.
- Warns when the game's own timer.xml changed since recorder/panorama/layout/hud/timer.xml was copied
  from it (the copy shadows it).
- Writes a marked block into cfg/autoexec.cfg: con_logfile yaw.log (the log the collector reads), and
  engine_no_focus_sleep 0, so replays watched while tabbed out record every tick. The first install
  keeps the original as autoexec.cfg.bak-strafe-review. Restart the game after installing.
- On Linux, links collector/strafe-review-run into ~/.local/bin for the Steam launch options.

The game folder comes from MOMENTUM_DIR or Steam's library folders, or --game.
--uninstall removes the recorder, the autoexec block and the link.
"""
import argparse
import hashlib
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "collector"))
import steam  # found through the path above

BEGIN = "// strafe-review begin"
END = "// strafe-review end"
# yaw.log is the name Source Yaw's yaws.cfg uses too; only one con_logfile is active, so both tools share it
BLOCK = [BEGIN, "con_logfile yaw.log", "engine_no_focus_sleep 0", END]
LINK = Path.home() / ".local" / "bin" / "strafe-review-run"


def without_block(lines):
    """lines (each with its line ending) minus our block; markers match with or without \\r."""
    out, inside = [], False
    for line in lines:
        bare = line.rstrip("\r\n")
        if bare == BEGIN:
            inside = True
        elif bare == END and inside:
            inside = False
        elif not inside:
            out.append(line)
    return out


def write_atomic(path, text):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def read_cfg(path):
    """The file's lines with their endings kept, and the line ending it uses (\\r\\n or \\n)."""
    text = path.read_text(encoding="utf-8", errors="surrogateescape", newline="") if path.exists() else ""
    return text.splitlines(keepends=True), "\r\n" if "\r\n" in text else "\n"


def set_autoexec(game, add):
    autoexec = Path(game) / "cfg" / "autoexec.cfg"
    lines, nl = read_cfg(autoexec)
    if add and not autoexec.exists():
        autoexec.touch()
    if add:
        backup = autoexec.with_name(autoexec.name + ".bak-strafe-review")
        if not backup.exists():
            shutil.copy2(autoexec, backup)
    elif not autoexec.exists():
        return
    lines = without_block(lines)
    if add:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += nl
        lines += [line + nl for line in BLOCK]
    write_atomic(autoexec, "".join(lines))
    print(f"{'updated' if add else 'removed the strafe-review block from'} {autoexec}")


def check_timer(game):
    """Warn if the game's timer.xml no longer matches the one the recorder's copy was made from."""
    upstream = Path(game) / "panorama" / "layout" / "hud" / "timer.xml"
    want = (ROOT / "recorder" / "timer.xml.upstream.sha256").read_text().split()[0]
    try:
        have = hashlib.sha256(upstream.read_bytes()).hexdigest()
    except OSError:
        have = None
    if have != want:
        print("warning: the game's timer.xml changed since the copy in recorder/ was made; diff it before playing:",
              file=sys.stderr)
        print(f'  diff "{upstream}" "{ROOT / "recorder/panorama/layout/hud/timer.xml"}"', file=sys.stderr)


def link_launcher(add):
    """Linux only: the Steam launch option wrapper, run from the repo (so keep the repo where it is)."""
    if sys.platform == "win32" or getattr(sys, "frozen", False):
        return
    if add:
        LINK.parent.mkdir(parents=True, exist_ok=True)
        if LINK.is_symlink() or LINK.exists():
            LINK.unlink()
        LINK.symlink_to(ROOT / "collector" / "strafe-review-run")
        print(f"linked {LINK}; Steam launch options: strafe-review-run %command%")
    elif LINK.is_symlink():
        LINK.unlink()
        print(f"removed {LINK}; take strafe-review-run out of the launch options too")


def install(game):
    check_timer(game)
    dest = Path(game) / "custom" / "strafe-review"
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(ROOT / "recorder" / "panorama", dest / "panorama")
    print(f"installed to {dest}")
    set_autoexec(game, add=True)
    link_launcher(add=True)


def uninstall(game):
    dest = Path(game) / "custom" / "strafe-review"
    shutil.rmtree(dest, ignore_errors=True)
    print(f"removed {dest}")
    set_autoexec(game, add=False)
    link_launcher(add=False)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--game", default=steam.find_game(), help="Momentum's game folder (holds cfg/ and custom/)")
    ap.add_argument("--uninstall", action="store_true", help="take Strafe Review out again")
    args = ap.parse_args()
    if not args.game or not (Path(args.game) / "cfg").is_dir():
        sys.exit("Momentum Mod not found in any Steam library; pass --game with its momentum folder")
    (uninstall if args.uninstall else install)(args.game)


if __name__ == "__main__":
    main()
