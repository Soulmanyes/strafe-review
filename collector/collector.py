#!/usr/bin/env python3
"""Collects the recorder's attempts from Momentum's yaw.log and saves them.

Usage: collector.py [yaw.log] [--once] [--store DIR]

Reads the log from the start, then follows it. Each complete attempt is saved as
<store>/<map>/<id>.json.gz, where <store> defaults to
~/.local/share/strafe-review/attempts. An attempt already on disk is skipped, so
reading the same log again is safe. --once reads to the end of the log and exits.
"""
import gzip
import json
import os
import re
import sys
import time
from pathlib import Path

from srrec import Assembler, body

GAME = os.environ.get(
    "MOMENTUM_DIR",
    os.path.expanduser("~/.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum"),
)
STORE = Path(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))) / "strafe-review" / "attempts"
POLL = 0.25  # seconds between reads when the log has nothing new
STALE = 600  # seconds after which an attempt without its end line is dropped


def follow(path, once=False):
    """Yield complete lines of path as they are written. Starts over when the file
    is truncated or replaced, and waits while it does not exist."""
    f, ino, buf = None, None, b""
    while True:
        if f is None:
            try:
                f = open(path, "rb")  # noqa: SIM115 - stays open across reads, closed on truncation
                ino = os.fstat(f.fileno()).st_ino
            except FileNotFoundError:
                if once:
                    return
                yield None
                time.sleep(POLL)
                continue
        data = f.read(1 << 16)
        if data:
            buf += data
            *lines, buf = buf.split(b"\n")
            for line in lines:
                yield line.decode("utf-8", "replace")
            continue
        if once:
            return
        try:
            st = os.stat(path)
            replaced = st.st_ino != ino or st.st_size < f.tell()
        except FileNotFoundError:
            replaced = True
        if replaced:
            f.close()
            f, buf = None, b""
            continue
        yield None  # idle tick
        time.sleep(POLL)


def map_dir(name):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name or "") or "unknown"


def known_ids(store):
    return {p.name.removesuffix(".json.gz") for p in store.glob("*/*.json.gz")}


def save(store, attempt):
    folder = store / map_dir(attempt.get("map"))
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{attempt['id']}.json.gz"
    # write then rename, so a reader never sees a half-written file
    tmp = folder / f".{attempt['id']}.tmp"
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(attempt, f, separators=(",", ":"))
    os.replace(tmp, path)
    return path


def run(log, store, once):
    known = known_ids(store)
    asm = Assembler()
    print(f"collector: reading {log}, saving to {store} ({len(known)} attempts already there)", flush=True)
    for line in follow(log, once):
        if line is None:
            for b in asm.drop_stale(STALE):
                print(f"collector: dropped {b}", flush=True)
            continue
        text = body(line)
        if text is None:
            continue
        got = asm.feed(text)
        if got is None:
            continue
        kind, value = got
        if kind == "broken":
            print(f"collector: dropped {value}", flush=True)
        elif kind == "attempt" and value.get("id") not in known:
            path = save(store, value)
            known.add(value["id"])
            print(f"collector: saved {path}", flush=True)
    for b in asm.leftover():
        print(f"collector: unfinished {b}", flush=True)


def main():
    args = sys.argv[1:]
    once = "--once" in args
    if once:
        args.remove("--once")
    store = STORE
    if "--store" in args:
        i = args.index("--store")
        store = Path(args[i + 1])
        del args[i:i + 2]
    log = args[0] if args else os.path.join(GAME, "yaw.log")
    try:
        run(log, store, once)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
