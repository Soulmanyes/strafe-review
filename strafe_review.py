#!/usr/bin/env python3
"""Strafe Review in one program, the entry point of the Windows exe.

    strafe-review.exe                 install or update the recorder, then collect and serve the
                                      page and open it in the browser (keep the window open while
                                      playing; closing it stops collecting)
    strafe-review.exe %command%       as a Steam launch option: install, start the server in the
                                      background, run the game, open the page when it quits

If a copy is already serving, a double-click only opens the page. The server reads yaw.log from the
start and skips attempts already saved, so attempts played while it wasn't running are picked up on
the next start. On Linux, collector/strafe-review-run stays the launch option wrapper.
"""
import os
import socket
import subprocess
import sys
import webbrowser
from pathlib import Path

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
sys.path[:0] = [str(ROOT), str(ROOT / "collector"), str(ROOT / "viewer")]  # finds the imports below
import server

import collector
import install

PORT = int(os.environ.get("STRAFE_REVIEW_PORT", "8765"))  # the variable is for tests
URL = f"http://127.0.0.1:{PORT}/"
SERVE = "--serve"  # internal: the background copy the launch option starts


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


def start_background():
    """Start a copy of this program that only serves, detached so it outlives the game."""
    me = [sys.executable] if getattr(sys, "frozen", False) else [sys.executable, str(Path(__file__).resolve())]
    kw = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    # a fresh PyInstaller instance with its own unpack folder; without this it would share this one's,
    # which is deleted when this copy exits after the game
    kw["env"] = {**os.environ, "PYINSTALLER_RESET_ENVIRONMENT": "1"}
    if sys.platform != "win32":
        kw["start_new_session"] = True
        subprocess.Popen([*me, SERVE], **kw)
        return
    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:
        # out of Steam's job object, if it has one, so Steam doesn't count the server as part of the game
        subprocess.Popen([*me, SERVE], creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB, **kw)
    except OSError:  # the job doesn't allow breaking away
        subprocess.Popen([*me, SERVE], creationflags=flags, **kw)


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
    if not serving():
        start_background()
    status = subprocess.call(game_cmd, env=game_env())
    if serving():
        webbrowser.open(URL)
    return status


def main():
    args = sys.argv[1:]
    if args == [SERVE]:
        return server.main(["--port", str(PORT), "--no-browser"])
    if args:
        return launch(args)
    if serving():
        webbrowser.open(URL)
        return None
    try_install()
    return server.main(["--port", str(PORT)])


if __name__ == "__main__":
    sys.exit(main())
