#!/usr/bin/env python3
"""Strafe Review viewer: serves the saved attempts and the review page on localhost.

    python viewer/server.py [--port 8765] [--game DIR] [--store DIR] [--log FILE] [--no-collect] [--no-browser]

It also runs the collector (collector/collector.py) in a thread, tailing Momentum's yaw.log, so one
process records and serves. If the port is taken, another copy is already doing both and this one exits.
Once it serves, it opens the page in the default browser.

Routes:
  /                          the page (viewer/static/index.html)
  /drill                     the jump-1 drill page (viewer/static/drill.html)
  /compare                   the compare page, 2-4 recordings side by side (viewer/static/compare.html)
  /static/<file>             page files
  /api/attempts              every saved attempt's header (no rows, plus rowCount, dir,
                             j1Takeoff, the jump-1 takeoff speed, j1Land, its landing speed
                             (null if it didn't land before the run end), landed, jumps 1+ that
                             landed before the run end, and runGaps, missed ticks inside
                             the run), newest first; note and tags from meta.json are merged in
  /api/attempt/<map>/<id>    one attempt, the .json.gz file sent as it is
  /api/mouse                 sensitivity and m_yaw from the game's config.cfg now, for attempts
                             recorded before the recorder stamped them (null if unreadable)
  /api/events                server-sent events: "attempt" with {dir, id} when a new attempt is saved
  POST /api/meta/<map>/<id>  {"note": str, "tags": [str]}: sets the attempt's note and tags, answers
                             with what was stored. Kept in <store>/meta.json, not in the attempt file.
"""
import argparse
import gzip
import json
import math
import os
import re
import struct
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "collector"))
import collector  # found through the path above

STATIC = collector.ROOT / "viewer" / "static"
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}
# Same characters collector.map_dir() keeps; a leading dot is refused so ".." never names a folder
MAP = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*")
ID = re.compile(r"[a-z0-9]{1,40}")
CVAR = re.compile(r'^\s*(sensitivity|m_yaw)\s+"([^"]*)"', re.MULTILINE)
STATIC_FILE = re.compile(r"[a-z0-9-]+\.(html|js|css)")

_heads = {}  # path -> (mtime_ns, size, head)
MOM_DIR = None  # Momentum's game folder; replayFile paths are relative to it
# .mtv header (formats 1 and 2 alike here, worked out from online replays, 2026-10-28): "MMTV", int32 version,
# int64 date, map name [64], map hash [41], uint16, float tick interval at 0x7b, uint64 SteamID,
# player name [33], one byte, then the run time as a double at 0xa9
MTV_INTERVAL = 0x7B
MTV_RUN_TIME = 0xA9
REPLAY_FINISH_TICKS = 2  # a replay that stopped this close to its run time was played to the end
META_FILE = "meta.json"  # {"version": 1, "attempts": {"<dir>/<id>": {"note": str, "tags": [str]}}}
_meta_lock = threading.Lock()
MAX_BODY = 16384
MAX_NOTE = 2000
MAX_TAG = 40
MAX_TAGS = 20
SPECTATE_MIN_AIR = 20  # same as static/data.js
POLL = 0.5  # seconds between store scans for /api/events
COLLECT_RETRY = 5  # seconds before the collector thread starts over after an error
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


def replay_run_time(data):
    """The run time stored in the attempt's replay file, or None when the file is gone or doesn't look
    like a format 1 or 2 replay with the attempt's tick interval."""
    rel = data.get("replayFile")
    if not rel or rel.startswith(("/", "\\")) or Path(rel).is_absolute() or ".." in Path(rel).parts:
        return None
    try:
        with open(MOM_DIR / rel, "rb") as f:
            b = f.read(MTV_RUN_TIME + 8)
    except OSError:
        return None
    if len(b) < MTV_RUN_TIME + 8 or b[:4] != b"MMTV" or struct.unpack_from("<i", b, 4)[0] not in (1, 2):
        return None
    interval = struct.unpack_from("<f", b, MTV_INTERVAL)[0]
    t = struct.unpack_from("<d", b, MTV_RUN_TIME)[0]
    if not data.get("interval") or abs(interval - data["interval"]) > 1e-6 or not 0 < t < 86400:
        return None
    return t


def replay_finished(data):
    """Momentum swaps a replay's timer (OnObservedTimerReplaced) when it loops, a tick before the timer
    would read FINISHED, so the recorder saves a replay played to the end as 'replaced'. Such a replay
    becomes a finish with the replay file's run time; the recorded end stays in recordedRunTime."""
    if data.get("label") != "replay" or data.get("reason") != "replaced" or not data.get("runTime"):
        return
    t = replay_run_time(data)
    if t is not None and t - data["runTime"] <= REPLAY_FINISH_TICKS * data["interval"] + 1e-6:
        data["recordedRunTime"] = data["runTime"]
        data["reason"] = "finish"
        data["runTime"] = t


def spectated(data):
    """True for an 'own' attempt that was really a live player being spectated: recorders before the
    'spectate' label saved those as 'own'. Their air rows never carry tick stats (ideal reads 0), the
    same rule parse() in static/data.js uses."""
    cols = data.get("cols") or []
    rows = data.get("rows") or ""
    if data.get("label") != "own" or not rows or not all(c in cols for c in ("ideal", "vz")):
        return False
    ii, iz = cols.index("ideal"), cols.index("vz")
    vals = [r.split(",") for r in rows.split(";")]
    ideal = [float(v[ii]) for v in vals]
    vz = [float(v[iz]) for v in vals]
    n = len(vz)
    air = [not (vz[i] == 0 and not ((vz[i - 1] if i else 0) > 0 and (vz[i + 1] if i < n - 1 else 0) < 0)) for i in range(n)]
    return sum(air) >= SPECTATE_MIN_AIR and not any(ideal[i] != 0 for i in range(n) if air[i])


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
    replay_finished(data)
    if spectated(data):
        data["label"] = "spectate"
    rows = data.pop("rows", "")
    data["rowCount"] = rows.count(";") + 1 if rows else 0
    data["dir"] = path.parent.name
    _heads[path] = (st.st_mtime_ns, st.st_size, data)
    return data


def read_meta(store):
    """meta.json's attempts map, {} if there is none or it can't be read."""
    try:
        with open(store / META_FILE) as f:
            return json.load(f).get("attempts") or {}
    except (OSError, ValueError, AttributeError):
        return {}


def clean_meta(body):
    """{"note", "tags"} from a POST body, trimmed; tags deduped ignoring case. Raises TypeError."""
    if not isinstance(body, dict):
        raise TypeError("body must be an object")
    note = body.get("note", "")
    tags = body.get("tags", [])
    if not isinstance(note, str) or not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
        raise TypeError("note must be a string and tags a list of strings")
    note = note.strip()[:MAX_NOTE]
    out, seen = [], set()
    for t in tags:
        t = " ".join(t.split())[:MAX_TAG]
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return {"note": note, "tags": out[:MAX_TAGS]}


def write_meta(store, key, entry):
    """Store one attempt's note and tags (an empty entry is removed), written to a temp file and renamed."""
    with _meta_lock:
        meta = read_meta(store)
        if entry["note"] or entry["tags"]:
            meta[key] = entry
        else:
            meta.pop(key, None)
        tmp = store / f".{META_FILE}.tmp"
        with open(tmp, "w") as f:
            json.dump({"version": 1, "attempts": meta}, f, indent=1, sort_keys=True)
        os.replace(tmp, store / META_FILE)


def attempts(store):
    out = []
    meta = read_meta(store)
    for path in store.glob("*/*.json.gz"):
        try:
            h = head(path)  # the cached dict: copied below, never changed
            m = meta.get(f"{path.parent.name}/{h.get('id')}") or {}
            out.append({**h, "note": m.get("note", ""), "tags": m.get("tags", [])})
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

    def local_request(self):
        """A POST from this viewer's own page: JSON, from 127.0.0.1/localhost on this port. Any page in
        the browser can send a plain-text POST to localhost; this refuses those."""
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("Origin")
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip()
        return (
            ctype == "application/json"
            and self.headers.get("Host") in hosts
            and (origin is None or origin.removeprefix("http://") in hosts)
        )

    def do_POST(self):
        parts = self.path.split("?", 1)[0].strip("/").split("/")
        if not (len(parts) == 4 and parts[:2] == ["api", "meta"] and MAP.fullmatch(parts[2]) and ID.fullmatch(parts[3])):
            return self.fail(404, "not found")
        if not self.local_request():
            return self.fail(403, "forbidden")
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = -1
        if not 0 < size <= MAX_BODY:
            return self.fail(413 if size > MAX_BODY else 400, "bad body size")
        if not (self.store / parts[2] / f"{parts[3]}.json.gz").is_file():
            return self.fail(404, "no such attempt")
        try:
            entry = clean_meta(json.loads(self.rfile.read(size)))
        except (ValueError, TypeError) as e:
            return self.fail(400, str(e))
        try:
            write_meta(self.store, f"{parts[2]}/{parts[3]}", entry)
        except OSError as e:
            return self.fail(500, f"could not save: {e}")
        self.send(200, json.dumps(entry).encode(), "application/json")

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


def collect(log, store):
    """Run the collector for good; an error is printed and the collector starts over, so the page never
    keeps showing while nothing is saved. Starting over is safe: attempts already on disk are skipped."""
    while True:
        try:
            collector.run(log, store, once=False)
        except Exception as e:  # noqa: BLE001 - any error, the thread must live on
            print(f"collector: {type(e).__name__}: {e}, starting over in {COLLECT_RETRY} s", file=sys.stderr, flush=True)
        time.sleep(COLLECT_RETRY)


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second copy bind the same port, so the busy-port check below
    # would never fire; leave it off there
    allow_reuse_address = sys.platform != "win32"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--store", default=str(collector.STORE))
    ap.add_argument("--game", default=collector.GAME, help="Momentum's game folder (holds cfg/ and yaw.log)")
    ap.add_argument("--game-cfg", help="Momentum's cfg/config.cfg (default: in --game)")
    ap.add_argument("--log", help="the console log to collect from (con_logfile; default: yaw.log in --game)")
    ap.add_argument("--no-collect", action="store_true", help="only serve, don't collect")
    ap.add_argument("--no-browser", action="store_true", help="don't open the page in the browser")
    args = ap.parse_args(argv)
    if not args.game and not (args.game_cfg and (args.log or args.no_collect)):
        sys.exit(f"Strafe Review: {collector.NOT_FOUND}, or pass --game")
    Handler.store = Path(args.store)
    Handler.game_cfg = Path(args.game_cfg or os.path.join(args.game, "cfg", "config.cfg"))
    if args.log is None and args.game:
        args.log = os.path.join(args.game, "yaw.log")
    global MOM_DIR
    MOM_DIR = Handler.game_cfg.parent.parent
    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError as e:
        # bound before collecting: a busy port means another copy is already collecting
        sys.exit(f"Strafe Review: port {args.port} is in use ({e.strerror}); is it already running?")
    if not args.no_collect:
        threading.Thread(target=collect, args=(args.log, Handler.store), daemon=True).start()
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Strafe Review viewer on {url} (attempts from {args.store})", flush=True)
    if not args.no_browser:
        # only the copy that got the port opens a tab, so a second start doesn't add one
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
