#!/usr/bin/env python3
"""Strafe Review in one program, the entry point of the Windows exe.

    strafe-review.exe                 install or update the recorder, then collect and serve the
                                      page and open it in the browser (keep the window open while
                                      playing; closing it stops collecting)
    strafe-review.exe %command%       as a Steam launch option: install, start the server in the
                                      background, run the game, open the page when it quits

Everything it prints also goes to strafe-review.log in %LOCALAPPDATA%\\strafe-review (the background
copy's only output). If a copy is already serving, a double-click only opens the page. The server
reads yaw.log from the start and skips attempts already saved, so attempts played while it wasn't
running are picked up on the next start. On Linux, collector/strafe-review-run stays the launch option wrapper.
"""
import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
sys.path[:0] = [str(ROOT), str(ROOT / "collector"), str(ROOT / "viewer")]  # finds the imports below
import server
import steam
import updater

import collector
import install

PORT = int(os.environ.get("STRAFE_REVIEW_PORT", "8765"))  # the variable is for tests
URL = f"http://127.0.0.1:{PORT}/"
SERVE = "--serve"  # internal: the background copy the launch option starts
RESTARTED = "--restarted"  # internal: a double-click copy started again after an update (no new tab)
LOG = steam.data_dir() / "strafe-review.log"
LOG_MAX = 1 << 20  # bytes; a longer log is started over
START_WAIT = 10  # seconds the launch option waits for the server it started, after the game


class Tee:
    """Writes to the console (if there is one) and to the log file."""

    def __init__(self, *streams):
        self.streams = [s for s in streams if s is not None]

    def write(self, text):
        for s in self.streams:
            try:
                s.write(text)
                s.flush()
            except (OSError, ValueError):
                pass
        return len(text)

    def flush(self):
        pass


def log_to_file():
    """Send this copy's output to the log file too. The background copy's console output goes nowhere,
    so the file is all there is of it."""
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        if LOG.exists() and LOG.stat().st_size > LOG_MAX:
            LOG.unlink()  # fails on Windows while another copy has it open; then it waits for the next start
    except OSError:
        pass
    try:
        f = open(LOG, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 - open for the program's life
    except OSError:
        return
    f.write(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(sys.argv[1:]) or '(double-click)'}\n")
    sys.stdout = Tee(sys.stdout, f)
    sys.stderr = Tee(sys.stderr, f)


def serving():
    """True if something answers on the port (this program, or a server started by hand)."""
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            return True
    except OSError:
        return False


def try_install():
    """Install or update the recorder and the autoexec block; a failure is shown, not fatal."""
    if not collector.GAME:
        print(f"Strafe Review: {collector.NOT_FOUND}; the recorder isn't installed", file=sys.stderr)
        return
    try:
        install.install(collector.GAME)
    except OSError as e:
        print(f"Strafe Review: install failed: {e}", file=sys.stderr)


def me():
    """The command that starts this program (after an update, the new exe at the same path)."""
    return [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, str(Path(__file__).resolve())]


def fresh_env():
    # a fresh PyInstaller instance with its own unpack folder; without this it would share this one's,
    # which is deleted when this copy exits
    return {**os.environ, "PYINSTALLER_RESET_ENVIRONMENT": "1"}


def start_console():
    """After an update: the double-click copy again, in a new console window, without a new tab."""
    if sys.platform == "win32":
        subprocess.Popen([*me(), RESTARTED], env=fresh_env(), creationflags=subprocess.CREATE_NEW_CONSOLE)
    else:
        subprocess.Popen([*me(), RESTARTED], env=fresh_env(), start_new_session=True)


def start_background(*extra):
    """Start a copy of this program that only serves, detached so it outlives the game."""
    kw = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "env": fresh_env()}
    if sys.platform != "win32":
        kw["start_new_session"] = True
        subprocess.Popen([*me(), SERVE, *extra], **kw)
        return
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:
        # out of Steam's job object, if it has one, so Steam doesn't count the server as part of the game
        subprocess.Popen([*me(), SERVE, *extra], creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kw)
    except OSError:  # the job doesn't allow breaking away
        subprocess.Popen([*me(), SERVE, *extra], creationflags=flags, **kw)


def game_env():
    """The environment for the game: PyInstaller's bootloader changes the library search path for its
    own unpacked libraries, which the game must not load. Restored as PyInstaller's docs describe."""
    if not getattr(sys, "frozen", False):
        return None
    if sys.platform == "win32":
        import ctypes

        ctypes.windll.kernel32.SetDllDirectoryW(None)
        return None
    env = dict(os.environ)
    for key in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
        orig = env.pop(key + "_ORIG", None)
        if orig is not None:
            env[key] = orig
        else:
            env.pop(key, None)
    return env


def launch(game_cmd):
    try_install()
    started = not serving()
    if started:
        start_background()
    status = subprocess.call(game_cmd, env=game_env())
    # a server started just now may still be starting if the game quit at once (a crash on launch)
    for _ in range(START_WAIT * 2 if started else 1):
        if serving():
            webbrowser.open(URL)
            break
        time.sleep(0.5)
    return status


def main():
    args = sys.argv[1:]
    log_to_file()
    updater.clean_old()
    if args[:1] == [SERVE]:
        # no install here, even after an update: the game may be starting and mounting custom/; the
        # launch wrapper (the new exe after an update) installs at every game start
        server.RESTART = lambda: start_background(RESTARTED)
        return server.main(["--port", str(PORT), "--no-browser"])
    if args == [RESTARTED]:
        try_install()
        server.RESTART = start_console
        return server.main(["--port", str(PORT), "--no-browser"])
    if args:
        return launch(args)
    if serving():
        webbrowser.open(URL)
        return None
    try_install()
    server.RESTART = start_console
    return server.main(["--port", str(PORT)])


if __name__ == "__main__":
    sys.exit(main())
