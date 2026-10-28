#!/usr/bin/env python3
"""Smoke test of the built program against a fake Momentum folder, no game or Steam needed.

Usage: python smoke_test.py dist/strafe-review(.exe)

Run by .github/workflows/windows.yml on the Windows build; it runs on Linux too. Checks:
1. Double-click: installs the recorder and the autoexec.cfg block, serves every page, opens the page,
   timer.xml is based on another HUD mod's copy that would win otherwise, /api/status sees the setup, and an attempt written into yaw.log the way the game writes it (file
   kept open, CRLF, chunks in separate writes) is collected and listed.
2. A second double-click while it runs only opens the page and exits; a second server on the busy port
   exits with an error (the SO_REUSEADDR check on Windows).
3. Launch option: runs the "game", hands back its exit code, leaves the server running, opens the page.
4. The page's Stop button (POST /api/stop) ends that background server.
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


SMOKE_ID = "smoketest1"
FAKE_TIMER = """<root>
\t<scripts>
\t\t<include type="module" src="file://{{scripts}}/hud/timer.ts" />
\t</scripts>
\t<MomHudTimer id="mod-{mod}" />
</root>
"""


def write_attempt(path):
    """Append one attempt as the recorder writes it: the game keeps the log open and writes CRLF lines,
    a chunk at a time."""
    data = json.dumps({"format": 1, "id": SMOKE_ID, "map": "bhop_smoke", "started": 1, "interval": 0.01,
                       "style": 0, "track": {"type": 0, "number": 0}, "label": "own", "player": None,
                       "cols": ["tick", "vx", "vy", "vz"], "rows": "0,0,0,0;1,10,0,0", "events": [],
                       "reason": "reset", "runTime": 0.01, "gaps": 0, "ended": 2})
    n = 3
    size = -(-len(data) // n)
    parts = [data[i * size:(i + 1) * size] for i in range(n)]
    with open(path, "ab", buffering=0) as f:
        f.write(b"[panorama] unrelated line\r\n")
        for i, part in enumerate(parts, 1):
            f.write(f"[panorama] SRREC {SMOKE_ID} {i}/{n} {part}\r\n".encode())
            time.sleep(0.6)
        f.write(f"[panorama] SRREC {SMOKE_ID} end n={n} chars={len(data)}\r\n".encode())
        time.sleep(3)  # still open while the collector reads, like the game


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
    (game / "panorama" / "layout" / "hud" / "timer.xml").write_text(FAKE_TIMER.format(mod="game"))
    # another HUD mod with its own timer.xml, mounted before "strafe-review" (like panoDev): ours must be
    # based on its file and win
    other = game / "custom" / "panoDev" / "panorama" / "layout" / "hud"
    other.mkdir(parents=True)
    (other / "timer.xml").write_text(FAKE_TIMER.format(mod="panoDev"))
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
        code, body = get("/api/status")
        st = json.loads(body) if code == 200 else {}
        if not (st.get("game") and Path(st["game"]).samefile(game) and st.get("recorder") and st.get("autoexecBlock")
                and st.get("collecting") and st.get("log", {}).get("exists")):
            fail(f"/api/status answered {code} {body[:300]!r}")
        write_attempt(game / "yaw.log")
        end = time.time() + 15
        while time.time() < end and SMOKE_ID not in get("/api/attempts")[1].decode():
            time.sleep(0.5)
        if SMOKE_ID not in get("/api/attempts")[1].decode():
            fail(f"the attempt written to yaw.log wasn't collected; status: {get('/api/status')[1][:400]!r}")
        st = json.loads(get("/api/status")[1])
        if st["saved"] != 1 or st["collector"]["recorder"] != 4:
            fail(f"status after collecting: {st}")
        ours = game / "custom" / "0-strafe-review" / "panorama"
        if not (ours / "scripts" / "hud" / "strafe-review.ts").is_file():
            fail("recorder not installed")
        timer = (ours / "layout" / "hud" / "timer.xml").read_text()
        if "mod-panoDev" not in timer or timer.count("strafe-review.ts") != 1:
            fail(f"timer.xml isn't panoDev's with our include:\n{timer}")
        autoexec = (game / "cfg" / "autoexec.cfg").read_bytes()
        want = b"exec something\r\n// strafe-review begin\r\ncon_logfile yaw.log\r\nengine_no_focus_sleep 0\r\n// strafe-review end\r\n"
        if autoexec != want:
            fail(f"autoexec.cfg is {autoexec!r}")
        time.sleep(2)
        if opened(tmp) != [URL]:
            fail(f"browser calls: {opened(tmp)}")
        print("   ok: pages, recorder, CRLF autoexec block, browser, status, attempt collected from a live log")

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
        log = tmp / "data" / "strafe-review" / "strafe-review.log"
        if "Strafe Review viewer on" not in (log.read_text(errors="replace") if log.exists() else ""):
            fail(f"the background copy's output isn't in {log}")
        print("   ok: exit code 3 handed back, background server running, page opened, output in strafe-review.log")

        print("4. Stop button")
        req = urllib.request.Request(URL + "api/stop", data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            if r.status != 200:
                fail(f"/api/stop answered {r.status}")
        time.sleep(3)
        if get("/")[0] is not None:
            fail("server still answers after /api/stop")
        print("   ok: the background server ended")
    finally:
        stop_all(exe)
        shutil.rmtree(tmp, ignore_errors=True)
    print("smoke test passed")


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    main()
