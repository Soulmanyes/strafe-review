#!/usr/bin/env python3
"""Reassemble the SRREC attempts from Momentum's yaw.log and check them.

Usage: check_recorder.py [yaw.log] [--save DIR]

Per attempt it prints the head fields and two self-checks:
- ticks: run rows + gaps against round(runTime / interval), should be within 1
- replay: tick - replay curtick should stay constant while a replay plays
--save writes each complete attempt to DIR/<id>.json.gz (the later collector's format).
"""
import gzip
import itertools
import json
import os
import re
import sys
from collections import Counter, defaultdict

GAME = os.environ.get(
    "MOMENTUM_DIR",
    os.path.expanduser("~/.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum"),
)
TAG = "SRREC "
CHUNK = re.compile(r"(\S+) (\d+)/(\d+) (.*)$")
END = re.compile(r"(\S+) end n=(\d+) chars=(\d+)$")


def read_lines(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            i = line.find(TAG)
            if i >= 0:
                yield line[i + len(TAG):].rstrip("\n")


def reassemble(lines):
    """Return (attempts, broken, other): complete attempts as dicts, broken ids, non-data lines."""
    chunks = defaultdict(dict)
    attempts, broken, other = [], [], []
    for body in lines:
        m = END.match(body)
        if m:
            aid, n, chars = m.group(1), int(m.group(2)), int(m.group(3))
            got = chunks.pop(aid, {})
            data = "".join(got.get(i, "") for i in range(1, n + 1))
            if len(got) != n or len(data) != chars:
                broken.append(f"{aid}: {len(got)}/{n} chunks, {len(data)}/{chars} chars")
                continue
            attempts.append(json.loads(data))
            continue
        m = CHUNK.match(body)
        if m:
            chunks[m.group(1)][int(m.group(2))] = m.group(4)
        else:
            other.append(body)
    broken += [f"{aid}: no end line ({len(got)} chunks)" for aid, got in chunks.items()]
    return attempts, broken, other


def rows(attempt):
    cols = attempt["cols"]
    return [dict(zip(cols, (float(v) for v in row.split(",")))) for row in attempt["rows"].split(";") if row]


def check(attempt):
    data = rows(attempt)
    run = data[attempt["preRows"]:]
    expected = round(attempt["runTime"] / attempt["interval"])
    got = len(run) + attempt["gaps"]
    ticks = [r["tick"] for r in data]
    backwards = sum(1 for a, b in itertools.pairwise(ticks) if b <= a)
    jumps = [e for e in attempt["events"] if e["kind"] == "jump"]
    print(
        f"{attempt['id']} {attempt['map']} {attempt['label']}"
        f"{' (' + attempt['player'] + ')' if attempt.get('player') else ''} {attempt['reason']}"
        f" style={attempt['style']} interval={attempt['interval']:.4f} practice={attempt['practice']}"
    )
    print(
        f"   rows {len(data)} (pre {attempt['preRows']}, run {len(run)}), gaps {attempt['gaps']}, "
        f"runTime {attempt['runTime']:.3f}s, jumps {len(jumps)}, ticks not increasing {backwards}"
    )
    if attempt["reason"] == "finish":
        verdict = "OK" if abs(got - expected) <= 1 else "OFF"
        print(f"   ticks: run rows + gaps = {got}, runTime says {expected}: {verdict} ({got - expected:+d})")
    offsets = Counter(int(r["tick"] - r["rtick"]) for r in data if r["rtick"] >= 0)
    if offsets:
        print(f"   replay: tick - curtick values {dict(offsets.most_common(5))} (one value = no drift)")
    keys = Counter(int(r["buttons"]) & (1 << 9 | 1 << 10) for r in run)
    print(f"   keys in run: none {keys[0]}, A {keys[1 << 9]}, D {keys[1 << 10]}, both {keys[1 << 9 | 1 << 10]}")


def main():
    args = sys.argv[1:]
    save = None
    if "--save" in args:
        i = args.index("--save")
        save = args[i + 1]
        del args[i:i + 2]
    log = args[0] if args else os.path.join(GAME, "yaw.log")

    attempts, broken, other = reassemble(read_lines(log))
    for body in other:
        print(body)
    for b in broken:
        print(f"BROKEN {b}")
    for attempt in attempts:
        check(attempt)
        if save:
            os.makedirs(save, exist_ok=True)
            with gzip.open(os.path.join(save, f"{attempt['id']}.json.gz"), "wt", encoding="utf-8") as f:
                json.dump(attempt, f)
    print(f"\n{len(attempts)} attempts, {len(broken)} broken")


main()
