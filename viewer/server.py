#!/usr/bin/env python3
"""Strafe Review viewer: serves the saved attempts and the review page on localhost.

    python viewer/server.py [--port 8765] [--store DIR]

Routes:
  /                          the page (viewer/static/index.html)
  /drill                     the jump-1 drill page (viewer/static/drill.html)
  /compare                   the compare page, 2-4 recordings side by side (viewer/static/compare.html)
  /static/<file>             page files
  /api/attempts              every saved attempt's header (no rows, plus rowCount, dir,
                             j1Takeoff, the jump-1 takeoff speed, j1Land, its landing speed
                             (null if it didn't land before the run end), landed, jumps 1+ that
                             landed before the run end, and runGaps, missed ticks inside
                             the run), newest first
  /api/attempt/<map>/<id>    one attempt, the .json.gz file sent as it is
  /api/mouse                 sensitivity and m_yaw from the game's config.cfg now, for attempts
                             recorded before the recorder stamped them (null if unreadable)
  /api/events                server-sent events: "attempt" with {dir, id} when a new attempt is saved
"""
import argparse
import gzip
import json
import math
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC = Path(__file__).resolve().parent / "static"
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}
# Same characters collector.map_dir() keeps; a leading dot is refused so ".." never names a folder
MAP = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*")
ID = re.compile(r"[a-z0-9]{1,40}")
GAME_CFG = "~/.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum/cfg/config.cfg"
CVAR = re.compile(r'^\s*(sensitivity|m_yaw)\s+"([^"]*)"', re.MULTILINE)
STATIC_FILE = re.compile(r"[a-z0-9-]+\.(html|js|css)")

_heads = {}  # path -> (mtime_ns, size, head)
POLL = 0.5  # seconds between store scans for /api/events
PING = 15  # seconds between keep-alive comments


def jump1_takeoff(data):
    """(takeoff, land, landed): horizontal speed at jump 1's takeoff, at its landing (None if it didn't
    land before the run end) and the number of jumps from jump 1 on that landed before the run end, found the same way as findJumps() in static/data.js.

    Ground is a row with vz exactly 0 that isn't an apex (rising before, falling after). A takeoff is
    vz going from 0.5 or less to over 100. Jump 1 is the air segment in progress at the timer start
    (row preRows), else the next one. Takeoff is None when there is no such jump.
    """
    cols = data.get("cols") or []
    rows = data.get("rows") or ""
    if not rows or not all(c in cols for c in ("vx", "vy", "vz")):
        return None, None, 0
    ix, iy, iz = cols.index("vx"), cols.index("vy"), cols.index("vz")
    vals = [r.split(",") for r in rows.split(";")]
    vx = [float(v[ix]) for v in vals]
    vy = [float(v[iy]) for v in vals]
    vz = [float(v[iz]) for v in vals]
    n = len(vz)
    ground = [vz[i] == 0 and not ((vz[i - 1] if i else 0) > 0 and (vz[i + 1] if i < n - 1 else 0) < 0) for i in range(n)]
    takeoffs = [i for i in range(1, n) if vz[i] > 100 and vz[i - 1] <= 0.5]
    p = min(data.get("preRows") or 0, n - 1)
    jumps = []
    for k, s in enumerate(takeoffs):
        stop = takeoffs[k + 1] if k + 1 < len(takeoffs) else n
        e = s + 1
        while e < stop and not ground[e]:
            e += 1
        jumps.append((s, e))
    j1 = next((j for j in jumps if j[0] <= p < j[1]), None) or next((j for j in jumps if j[0] >= p), None)
    if j1 is None:
        return None, None, 0
    end = n - 1 - (data.get("postRows") or 0)
    landed = sum(1 for j in jumps[jumps.index(j1):] if j[1] <= end and j[1] < n)
    land = round(math.hypot(vx[j1[1] - 1], vy[j1[1] - 1]), 2) if j1[1] <= end and j1[1] < n else None
    return round(math.hypot(vx[j1[0]], vy[j1[0]]), 2), land, landed


def run_gaps(data):
    """Missed ticks inside the run, as runGaps() in static/data.js: from the timer start to the run
    end (runTime, else the last row before the post-end tail). A replay's pause at its end isn't counted."""
    cols = data.get("cols") or []
    rows = data.get("rows") or ""
    if not rows or "tick" not in cols:
        return data.get("gaps") or 0
    it = cols.index("tick")
    ticks = [float(r.split(",")[it]) for r in rows.split(";")]
    n = len(ticks)
    p = min(data.get("preRows") or 0, n - 1)
    last = n - 1 - (data.get("postRows") or 0)
    run_time = data.get("runTime")
    span = round(run_time / data["interval"]) if run_time else math.inf
    g = 0
    for i in range(p + 1, last + 1):
        if ticks[i] - ticks[p] > span:
            break
        g += ticks[i] - ticks[i - 1] - 1
    return int(g)


def head(path):
    """The attempt's JSON without its rows, cached until the file changes."""
    st = path.stat()
    got = _heads.get(path)
    if got and got[:2] == (st.st_mtime_ns, st.st_size):
        return got[2]
    with gzip.open(path, "rt") as f:
        data = json.load(f)
    data["j1Takeoff"], data["j1Land"], data["landed"] = jump1_takeoff(data)
    data["runGaps"] = run_gaps(data)
    rows = data.pop("rows", "")
    data["rowCount"] = rows.count(";") + 1 if rows else 0
    data["dir"] = path.parent.name
    _heads[path] = (st.st_mtime_ns, st.st_size, data)
    return data


def attempts(store):
    out = []
    for path in store.glob("*/*.json.gz"):
        try:
            out.append(head(path))
        except (OSError, ValueError, EOFError) as e:
            print(f"skipped {path}: {e}", file=sys.stderr)
    out.sort(key=lambda a: a.get("started") or 0, reverse=True)
    return out


def game_mouse(cfg):
    """sensitivity and m_yaw from config.cfg (written by the game when it quits), or None."""
    try:
        found = {k: float(v) for k, v in CVAR.findall(cfg.read_text(errors="replace"))}
    except (OSError, ValueError):
        return None
    return found if len(found) == 2 else None


def snapshot(store):
    """Every saved attempt file. The collector writes .<id>.tmp and renames it, so the glob only sees whole files."""
    return set(store.glob("*/*.json.gz"))


class Handler(BaseHTTPRequestHandler):
    store = None
    game_cfg = None

    def send(self, code, body, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def fail(self, code, text):
        self.send(code, text.encode(), "text/plain; charset=utf-8")

    def events(self):
        """Push an "attempt" event for each new file in the store, until the page goes away."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        seen = snapshot(self.store)
        last = time.monotonic()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                time.sleep(POLL)
                now = snapshot(self.store)
                for path in sorted(now - seen, key=lambda p: p.stat().st_mtime_ns if p.exists() else 0):
                    msg = json.dumps({"dir": path.parent.name, "id": path.name.removesuffix(".json.gz")})
                    self.wfile.write(f"event: attempt\ndata: {msg}\n\n".encode())
                    last = time.monotonic()
                seen = now
                if time.monotonic() - last > PING:
                    self.wfile.write(b": ping\n\n")
                    last = time.monotonic()
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        parts = self.path.split("?", 1)[0].strip("/").split("/")
        if parts == [""]:
            parts = ["static", "index.html"]
        elif parts == ["drill"]:
            parts = ["static", "drill.html"]
        elif parts == ["compare"]:
            parts = ["static", "compare.html"]
        if len(parts) == 2 and parts[0] == "static" and STATIC_FILE.fullmatch(parts[1]):
            path = STATIC / parts[1]
            if path.is_file():
                ctype = TYPES[path.suffix] + "; charset=utf-8"
                return self.send(200, path.read_bytes(), ctype)
        elif parts == ["api", "events"]:
            return self.events()
        elif parts == ["api", "mouse"]:
            return self.send(200, json.dumps(game_mouse(self.game_cfg)).encode(), "application/json")
        elif parts == ["api", "attempts"]:
            body = json.dumps(attempts(self.store)).encode()
            return self.send(200, body, "application/json")
        elif len(parts) == 4 and parts[:2] == ["api", "attempt"]:
            if MAP.fullmatch(parts[2]) and ID.fullmatch(parts[3]):
                path = self.store / parts[2] / f"{parts[3]}.json.gz"
                if path.is_file():
                    return self.send(200, path.read_bytes(), "application/json", {"Content-Encoding": "gzip"})
        self.fail(404, "not found")

    def log_message(self, fmt, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--store", default=os.path.expanduser("~/.local/share/strafe-review/attempts"))
    ap.add_argument("--game-cfg", default=os.path.expanduser(GAME_CFG), help="Momentum's cfg/config.cfg")
    args = ap.parse_args()
    Handler.store = Path(args.store)
    Handler.game_cfg = Path(args.game_cfg)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Strafe Review viewer on http://127.0.0.1:{args.port}/ (attempts from {args.store})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
