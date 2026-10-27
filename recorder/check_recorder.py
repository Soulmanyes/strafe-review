#!/usr/bin/env python3
"""Reassemble the SRREC attempts from Momentum's yaw.log and check them.

Usage: check_recorder.py [yaw.log] [--save DIR]

Per attempt it prints the head fields and two self-checks:
- ticks: run rows + gaps against round(runTime / interval), should be within 1
- replay: tick - replay curtick should stay constant while a replay plays
--save writes each complete attempt to DIR/<map>/<id>.json.gz, like the collector.
"""
import itertools
import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "collector"))
from collector import save  # after the path above
from srrec import reassemble

GAME = os.environ.get(
    "MOMENTUM_DIR",
    os.path.expanduser("~/.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum"),
)


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
    save_dir = None
    if "--save" in args:
        i = args.index("--save")
        save_dir = args[i + 1]
        del args[i:i + 2]
    log = args[0] if args else os.path.join(GAME, "yaw.log")

    with open(log, encoding="utf-8", errors="replace") as f:
        attempts, broken, other = reassemble(f)
    for body in other:
        print(body)
    for b in broken:
        print(f"BROKEN {b}")
    for attempt in attempts:
        check(attempt)
        if save_dir:
            save(Path(save_dir), attempt)
    print(f"\n{len(attempts)} attempts, {len(broken)} broken")


if __name__ == "__main__":
    main()
