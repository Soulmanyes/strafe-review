#!/usr/bin/env python3
"""Smoke test of the built program against a fake Momentum folder, no game or Steam needed.

Usage: python smoke_test.py dist/strafe-review(.exe)

Run by .github/workflows/windows.yml on the Windows build; it runs on Linux too. Checks:
1. Double-click: installs the recorder and the autoexec.cfg block, serves every page, opens the page.
2. A second double-click while it runs only opens the page and exits; a second server on the busy port
   exits with an error (the SO_REUSEADDR check on Windows).
3. Launch option: runs the "game", hands back its exit code, leaves the server running, opens the page.
The browser is a stand-in that writes the URL to a file.
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

PORT = 8790
URL = f"http://127.0.0.1:{PORT}/"
ROOT = Path(__file__).resolve().parent
WIN = sys.platform == "win32"


def fail(msg):
    sys.exit(f"FAIL: {msg}")


def get(path):
    try:
        with urllib.request.urlopen(URL.rstrip("/") + path, timeout=2) as r:
            return r.status, r.read()
    except OSError:
        return None, b""


def wait_serving(timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if get("/")[0] == 200:
            return
        time.sleep(0.5)
    fail(f"nothing serves {URL} after {timeout} s")


def opened(tmp):
    f = tmp / "opened.txt"
    return f.read_text().split() if f.exists() else []


def stop_all(exe):
    """End every copy of the program (a one-file build runs as a bootloader plus a child)."""
    if WIN:
        subprocess.call(["taskkill", "/F", "/T", "/IM", exe.name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        subprocess.call(["pkill", "-f", f"^{exe}"])
    time.sleep(1)


def main():
    exe = Path(sys.argv[1]).resolve()
    tmp = Path(tempfile.mkdtemp(prefix="sr-smoke-"))
    game = tmp / "game"
    (game / "cfg").mkdir(parents=True)
    (game / "panorama" / "layout" / "hud").mkdir(parents=True)
    shutil.copy(ROOT / "recorder" / "panorama" / "layout" / "hud" / "timer.xml", game / "panorama" / "layout" / "hud")
    (game / "cfg" / "autoexec.cfg").write_bytes(b"exec something\r\n")  # CRLF, as Windows editors write it
    (game / "yaw.log").write_text("")
    browser = tmp / "browser.py"
    browser.write_text(f"import sys\nopen({str(tmp / 'opened.txt')!r}, 'a').write(sys.argv[1] + '\\n')\n")
    env = {
        **os.environ,
        "MOMENTUM_DIR": str(game),
        "STRAFE_REVIEW_PORT": str(PORT),
        "LOCALAPPDATA": str(tmp / "data"),
        "XDG_DATA_HOME": str(tmp / "data"),
        "HOME": str(tmp / "home"),  # install.py links strafe-review-run under it on Linux (not when frozen)
        # forward slashes: webbrowser splits BROWSER like a POSIX shell, which eats backslashes
        "BROWSER": f'"{Path(sys.executable).as_posix()}" "{browser.as_posix()}" %s',
    }
    stop_all(exe)
    try:
        print("1. double-click")
        first = subprocess.Popen([exe], env=env)
        wait_serving()
        for path in ("/", "/drill", "/compare", "/static/app.js", "/static/style.css"):
            code, _ = get(path)
            if code != 200:
                fail(f"{path} answered {code}")
        code, body = get("/api/attempts")
        if code != 200 or json.loads(body) != []:
            fail(f"/api/attempts answered {code} {body[:100]!r}")
        if not (game / "custom" / "strafe-review" / "panorama" / "scripts" / "hud" / "strafe-review.ts").is_file():
            fail("recorder not installed")
        autoexec = (game / "cfg" / "autoexec.cfg").read_bytes()
        want = b"exec something\r\n// strafe-review begin\r\ncon_logfile yaw.log\r\nengine_no_focus_sleep 0\r\n// strafe-review end\r\n"
        if autoexec != want:
            fail(f"autoexec.cfg is {autoexec!r}")
        time.sleep(2)
        if opened(tmp) != [URL]:
            fail(f"browser calls: {opened(tmp)}")
        print("   ok: pages, recorder, CRLF autoexec block, browser")

        print("2. second copy while running")
        r = subprocess.run([exe], env=env, timeout=60, capture_output=True, text=True, check=False)
        if r.returncode != 0 or opened(tmp) != [URL, URL]:
            fail(f"second double-click: exit {r.returncode}, browser calls {opened(tmp)}")
        r = subprocess.run([exe, "--serve"], env=env, timeout=60, capture_output=True, text=True, check=False)
        if r.returncode == 0 or "in use" not in r.stderr:
            fail(f"second server on the busy port: exit {r.returncode}, stderr {r.stderr!r}")
        if first.poll() is not None:
            fail("first copy died")
        print("   ok: only opened the page; a second server refused the busy port")
        stop_all(exe)
        if get("/")[0] is not None:
            fail("server still answers after stopping it")

        print("3. launch option")
        r = subprocess.run([exe, sys.executable, "-c", "import sys; sys.exit(3)"],
                           env=env, timeout=120, capture_output=True, text=True, check=False)
        if r.returncode != 3:
            fail(f"game exit code came back as {r.returncode}; stderr {r.stderr!r}")
        wait_serving()
        time.sleep(2)
        if opened(tmp)[-1:] != [URL] or len(opened(tmp)) != 3:
            fail(f"browser calls: {opened(tmp)}")
        print("   ok: exit code 3 handed back, background server running, page opened")
    finally:
        stop_all(exe)
        shutil.rmtree(tmp, ignore_errors=True)
    print("smoke test passed")


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    main()
