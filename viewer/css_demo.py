"""Turn a CS:S client demo (.dem) into a recording the viewer's data.js can read, to check the CS:S gain
against a real server's SSJ chat lines (node viewer/check_css_ssj.js).

    python -I viewer/css_demo.py DEMO.dem OUT.json

Record in game with `record <name>` (not while flashed: on bhop servers that hide the radar, start it while
dead or spectating) and `stop`. Keep the console's [SSJ] lines (copy them, con_logfile cuts off).

What the demo gives (measured 2026-10-28 on one 100-tick bhop server):
- Packet frames carry the player's origin, one server tick each, in order; their tick labels jitter with the
  client frame rate, so the order is used, not the label. A zero origin is skipped. Velocity = origin
  change / tick interval.
- Usercmd frames carry the commands (angles, forward/side move, buttons), one per tick. Packet k goes with
  command k + lag; the lag is fitted with CS:S air physics (add up to 30 u/s along wishdir).
- Now and then a packet repeats the previous origin mid-air and the next one moves two ticks: both ticks are
  rebuilt from the air physics and the two-tick move.
"""
import json
import math
import struct
import sys

INTERVAL = 0.01
AIR_ADD = 30.0


class Bits:
    def __init__(self, data):
        self.b = data
        self.p = 0

    def u(self, n):
        v = 0
        for k in range(n):
            v |= ((self.b[self.p >> 3] >> (self.p & 7)) & 1) << k
            self.p += 1
        return v

    def f(self):
        return struct.unpack("<f", struct.pack("<I", self.u(32)))[0]


def usercmd(data):
    """CUserCmd as the Orange Box engine writes it: each field behind a 'changed' bit, delta from an empty cmd."""
    r = Bits(data)
    c = {}

    def opt(name, read):
        if r.u(1):
            c[name] = read()

    opt("cmd", lambda: r.u(32))
    opt("tick", lambda: r.u(32))
    opt("pitch", r.f)
    opt("yaw", r.f)
    opt("roll", r.f)
    opt("fwd", r.f)
    opt("side", r.f)
    opt("up", r.f)
    opt("buttons", lambda: r.u(32))
    opt("impulse", lambda: r.u(8))
    if r.u(1):
        c["weapon"] = r.u(11)
        if r.u(1):
            c["subtype"] = r.u(6)
    opt("mdx", lambda: r.u(16))
    opt("mdy", lambda: r.u(16))
    return c


def read_demo(path):
    with open(path, "rb") as f:
        b = f.read()
    if b[:8] != b"HL2DEMO\0":
        sys.exit("not a Source demo")
    head = {"map": b[536:796].split(b"\0")[0].decode(errors="replace")}
    o = 1072
    origins, cmds = [], []
    while o + 5 <= len(b):
        kind = b[o]
        o += 5  # command byte, int32 tick
        if kind in (1, 2):  # signon / packet: 76-byte cmdinfo, 2 sequence numbers, sized data
            info = struct.unpack_from("<i18f", b, o)
            o += 84
            (n,) = struct.unpack_from("<i", b, o)
            o += 4 + n
            if kind == 2 and any(info[1:4]):
                origins.append(info[1:4])
        elif kind == 5:  # usercmd: sequence number, sized data
            _, n = struct.unpack_from("<ii", b, o)
            o += 8
            cmds.append(usercmd(b[o : o + n]))
            o += n
        elif kind in (4, 6, 8):  # console command, data tables, string tables
            (n,) = struct.unpack_from("<i", b, o)
            o += 4 + n
        elif kind == 3:  # synctick
            pass
        else:  # 7 = stop
            break
    return head, origins, cmds


def wish(c):
    """Unnormalised wish velocity from the command's yaw and forward/side move (pitch drops out in CS:S)."""
    y = math.radians(c.get("yaw", 0.0))
    f, s = c.get("fwd", 0.0), c.get("side", 0.0)
    return math.cos(y) * f + math.sin(y) * s, math.sin(y) * f - math.cos(y) * s


def unit(w):
    n = math.hypot(*w)
    return (w[0] / n, w[1] / n) if n > 0 else None


def air_move(v0, w):
    u = unit(w)
    if not u:
        return v0[0], v0[1]
    add = max(0.0, AIR_ADD - (v0[0] * u[0] + v0[1] * u[1]))
    return v0[0] + add * u[0], v0[1] + add * u[1]


def fit_lag(vel, cmds):
    """Command offset whose wishdir best predicts each air tick's velocity change: (lag, median error u/s)."""
    best = None
    for lag in range(-15, 16):
        errs = []
        for k in range(2, len(vel)):
            v0, v1, i = vel[k - 1], vel[k], k + lag
            if abs(v1[2] - v0[2] + 8) > 1 or not 0 <= i < len(cmds) or not unit(wish(cmds[i])):
                continue  # air ticks with a key only (gravity takes 8 u/s off vz per tick)
            px, py = air_move(v0, wish(cmds[i]))
            errs.append(math.hypot(v1[0] - px, v1[1] - py))
        if errs:
            errs.sort()
            if best is None or errs[len(errs) // 2] < best[1]:
                best = (lag, errs[len(errs) // 2])
    return best


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    head, origins, cmds = read_demo(sys.argv[1])
    vel = [(0.0, 0.0, 0.0)] + [
        tuple((origins[k][j] - origins[k - 1][j]) / INTERVAL for j in range(3)) for k in range(1, len(origins))
    ]
    lag, err = fit_lag(vel, cmds)
    fixed = 0
    for k in range(2, len(vel) - 1):
        v0, v1, v2 = vel[k - 1], vel[k], vel[k + 1]
        if v1 == (0.0, 0.0, 0.0) and v0[2] != 0 and abs(v2[2] - 2 * v0[2]) < 40 and 0 <= k + lag < len(cmds):
            a = (*air_move(v0, wish(cmds[k + lag])), v0[2] - 8)
            vel[k], vel[k + 1] = a, tuple(v2[j] - a[j] for j in range(3))
            fixed += 1
    rows = []
    for k in range(1, len(vel)):
        i = k + lag
        if not 0 <= i < len(cmds):
            continue
        c, v = cmds[i], vel[k]
        wx, wy = wish(c)
        vz = 0.0 if abs(v[2]) < 0.01 else v[2]  # the viewer finds ground by vz == 0
        # tick stats as Momentum gives them (gain = speed change, ideal = best possible), so data.js treats this
        # as the player's own run and not as a spectated one
        s0, s1 = math.hypot(*vel[k - 1][:2]), math.hypot(*v[:2])
        gain, ideal = (s1 - s0, math.sqrt(s0 * s0 + AIR_ADD * AIR_ADD) - s0) if vz else (0.0, 0.0)
        rows.append(f"{k},{gain:.3f},{ideal:.3f},0,0,{v[0]:.4f},{v[1]:.4f},{vz:.4f},{c.get('yaw', 0):.4f},{c.get('buttons', 0)},{wx:.3f},{wy:.3f}")
    out = {
        "format": 1,
        "id": "cssdemo",
        "map": head["map"],
        "interval": INTERVAL,
        "label": "own",
        "cols": ["tick", "gain", "ideal", "ratio", "right", "vx", "vy", "vz", "yaw", "buttons", "wx", "wy"],
        "preRows": 0,
        "postRows": 0,
        "events": [],
        "rows": ";".join(rows),
    }
    with open(sys.argv[2], "w") as f:
        json.dump(out, f)
    print(f"{head['map']}: {len(origins)} packets, {len(cmds)} commands, lag {lag} (median error {err:.3f} u/s), "
          f"{fixed} stalled packets rebuilt, {len(rows)} rows")


if __name__ == "__main__":
    main()
