#!/usr/bin/env python3
"""Strafe Review viewer: serves the saved attempts and the review page on localhost.

    python viewer/server.py [--port 8765] [--store DIR]

Routes:
  /                          the page (viewer/static/index.html)
  /static/<file>             page files
  /api/attempts              every saved attempt's header (no rows), newest first
  /api/attempt/<map>/<id>    one attempt, the .json.gz file sent as it is
"""
import argparse
import gzip
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC = Path(__file__).resolve().parent / "static"
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}
# Same characters collector.map_dir() keeps; a leading dot is refused so ".." never names a folder
MAP = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*")
ID = re.compile(r"[a-z0-9]{1,40}")
STATIC_FILE = re.compile(r"[a-z0-9-]+\.(html|js|css)")

_heads = {}  # path -> (mtime_ns, size, head)


def head(path):
    """The attempt's JSON without its rows, cached until the file changes."""
    st = path.stat()
    got = _heads.get(path)
    if got and got[:2] == (st.st_mtime_ns, st.st_size):
        return got[2]
    with gzip.open(path, "rt") as f:
        data = json.load(f)
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


class Handler(BaseHTTPRequestHandler):
    store = None

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

    def do_GET(self):
        parts = self.path.split("?", 1)[0].strip("/").split("/")
        if parts == [""]:
            parts = ["static", "index.html"]
        if len(parts) == 2 and parts[0] == "static" and STATIC_FILE.fullmatch(parts[1]):
            path = STATIC / parts[1]
            if path.is_file():
                ctype = TYPES[path.suffix] + "; charset=utf-8"
                return self.send(200, path.read_bytes(), ctype)
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
    args = ap.parse_args()
    Handler.store = Path(args.store)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Strafe Review viewer on http://127.0.0.1:{args.port}/ (attempts from {args.store})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
