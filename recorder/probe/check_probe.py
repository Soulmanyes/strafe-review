#!/usr/bin/env python3
"""Read the SRPROBE lines from Momentum's yaw.log and answer the three first-step checks.

Only the last probe session is read: it starts at the last "load" line, or at the
first heartbeat after the last non-heartbeat gap if no load line made it into the log.
"""
import os
import re
import sys
from collections import defaultdict

GAME = os.environ.get(
    "MOMENTUM_DIR",
    os.path.expanduser("~/.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum"),
)
LOG = sys.argv[1] if len(sys.argv) > 1 else os.path.join(GAME, "yaw.log")
TAG = "SRPROBE "


def probe_lines(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        lines = [line.rstrip("\n") for line in f]
    out = []
    for line in lines:
        i = line.find(TAG)
        if i >= 0:
            out.append((line[:i], line[i + len(TAG):]))
    return out


def last_session(lines):
    start = 0
    for i, (_, body) in enumerate(lines):
        if body.startswith("load "):
            start = i
    return lines[start:]


def main():
    lines = last_session(probe_lines(LOG))
    if not lines:
        print(f"no SRPROBE lines in {LOG}: check 1 failed (or con_logfile was off)")
        return
    prefix = lines[0][0]
    print(f"{len(lines)} SRPROBE lines, prefix before the tag: {prefix!r}")

    loads = [b for _, b in lines if b.startswith("load ")]
    hbs = [b for _, b in lines if b.startswith("hb ")]
    errs = [b for _, b in lines if b.startswith("err ")]
    print(f"\n1. load: {loads[-1] if loads else 'no load line'}; heartbeats: {len(hbs)}")
    for e in errs:
        print(f"   {e}")
    for hb in hbs[-5:]:
        print(f"   {hb}")
    for key in [b for _, b in lines if b.startswith("keys ")]:
        print(f"   {key}")
    for hb in [b for _, b in lines if b.startswith(("hb3 ", "hb4 "))][-5:]:
        print(f"   {hb}")
    mismatched = []
    for hb in hbs[1:]:
        f = dict(kv.split("=", 1) for kv in hb.split()[1:])
        if int(f["expected"]) != int(f["dticks"]) + int(f["dgaps"]):
            mismatched.append(hb)
    print(f"   heartbeats where expected != dticks + dgaps: {len(mismatched)}")

    print("\n2. long lines:")
    for _, body in lines:
        m = re.match(r"len (\d+) ", body)
        if m:
            n = int(m.group(1))
            whole = body.endswith(f" END{n}")
            print(f"   {n:>6}: {'whole' if whole else 'CUT'} (got {len(TAG) + len(body)} chars)")

    print("\n3. dumps:")
    chunks = defaultdict(dict)
    totals = {}
    for _, body in lines:
        m = re.match(r"chunk (\S+) (\d+)/(\d+) (.*)$", body)
        if m:
            chunks[m.group(1)][int(m.group(2))] = m.group(4)
            totals[m.group(1)] = int(m.group(3))
    for _, body in lines:
        m = re.match(r"dump (\S+) rows=(\d+) chars=(\d+) chunks=(\d+) ms=(\d+)", body)
        if not m:
            continue
        label, rows, chars, count, ms = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4)), m.group(5)
        got = chunks.get(label, {})
        missing = [i for i in range(1, count + 1) if i not in got]
        data = "".join(got[i] for i in sorted(got))
        got_rows = len(data.split(";")) if data else 0
        ok = not missing and len(data) == chars and got_rows == rows
        print(
            f"   {label}: {rows} rows, {chars} chars, {count} chunks, {ms} ms; "
            f"{'reassembled OK' if ok else f'BROKEN (missing {len(missing)} chunks, {len(data)} chars, {got_rows} rows)'}"
        )

    print("\njumps:")
    for _, body in lines:
        if body.startswith(("jump ", "timer ")):
            print(f"   {body}")


main()
