"""Reads SRREC wire format 1 (see PLAN.md) from Momentum's console log.

Every recorder line is `[panorama] SRREC <id> <i>/<n> <text>` (a chunk) or
`[panorama] SRREC <id> end n=<n> chars=<c>` (the last line of an attempt).
The chunks of one id, joined in order, are one JSON object.
"""
import json
import re
import time

TAG = "[panorama] SRREC "
CHUNK = re.compile(r"(\S+) (\d+)/(\d+) (.*)$")
END = re.compile(r"(\S+) end n=(\d+) chars=(\d+)$")


def body(line):
    """The text after the SRREC tag, or None if the line is not from the recorder."""
    i = line.find(TAG)
    return None if i < 0 else line[i + len(TAG):].rstrip("\r\n")


class Assembler:
    """Puts chunks back together one line at a time.

    feed() returns ("attempt", dict), ("broken", text), ("other", body) or None
    (a chunk was stored)."""

    def __init__(self):
        self.chunks = {}  # id -> {i: text}
        self.seen = {}  # id -> time.monotonic() of its last chunk

    def feed(self, text):
        m = END.match(text)
        if m:
            aid, n, chars = m.group(1), int(m.group(2)), int(m.group(3))
            got = self.chunks.pop(aid, {})
            self.seen.pop(aid, None)
            data = "".join(got.get(i, "") for i in range(1, n + 1))
            if len(got) != n or len(data) != chars:
                return "broken", f"{aid}: {len(got)}/{n} chunks, {len(data)}/{chars} chars"
            try:
                return "attempt", json.loads(data)
            except ValueError as e:
                return "broken", f"{aid}: bad JSON ({e})"
        m = CHUNK.match(text)
        if m:
            self.chunks.setdefault(m.group(1), {})[int(m.group(2))] = m.group(4)
            self.seen[m.group(1)] = time.monotonic()
            return None
        return "other", text

    def drop_stale(self, max_age):
        """Forget ids with no chunk for max_age seconds (their end line never came).
        Returns them as broken texts."""
        now = time.monotonic()
        old = [aid for aid, t in self.seen.items() if now - t > max_age]
        out = []
        for aid in old:
            out.append(f"{aid}: no end line ({len(self.chunks.pop(aid))} chunks)")
            del self.seen[aid]
        return out

    def leftover(self):
        """Ids still waiting for their end line, as broken texts."""
        return [f"{aid}: no end line ({len(got)} chunks)" for aid, got in self.chunks.items()]


def reassemble(lines):
    """Return (attempts, broken, other) for a whole log: complete attempts as dicts,
    broken ids, non-data recorder lines."""
    asm = Assembler()
    attempts, broken, other = [], [], []
    for line in lines:
        text = body(line)
        if text is None:
            continue
        got = asm.feed(text)
        if got is None:
            continue
        kind, value = got
        (attempts if kind == "attempt" else broken if kind == "broken" else other).append(value)
    return attempts, broken + asm.leftover(), other
