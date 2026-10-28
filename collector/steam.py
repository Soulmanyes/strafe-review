"""Finds Momentum Mod's game folder (the one holding cfg/ and custom/) through Steam.

Order: the MOMENTUM_DIR environment variable, then every Steam library listed in
steamapps/libraryfolders.vdf under the Steam roots of this system. A library holds the game when
one of its steamapps/appmanifest_*.acf files names Momentum; the manifest's installdir gives the
folder, so the playtest and any other build are both found.
"""
import os
import re
import sys
from pathlib import Path

GAME_SUBDIR = "momentum"  # inside the install folder, next to the engine files
# "key" "value" pairs of a Valve KeyValues file; nesting is not needed for the keys read here
KV = re.compile(r'"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"')


def unescape(s):
    """KeyValues strings escape backslashes ("D:\\\\SteamLibrary" on Windows)."""
    return re.sub(r"\\(.)", r"\1", s)


def pairs(path):
    """(key, value) pairs of a KeyValues file, in file order; [] if it can't be read."""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return [(k.lower(), unescape(v)) for k, v in KV.findall(text)]


def steam_roots():
    """Steam install folders on this system that exist, without duplicates."""
    if sys.platform == "win32":
        roots = []
        try:
            import winreg

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
                roots.append(winreg.QueryValueEx(key, "SteamPath")[0])
        except OSError:
            pass
        roots.append(os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "Steam"))
    else:
        home = Path.home()
        roots = [
            os.path.join(os.environ.get("XDG_DATA_HOME", home / ".local/share"), "Steam"),
            home / ".steam/steam",
            home / ".var/app/com.valvesoftware.Steam/.local/share/Steam",  # Flatpak
        ]
    seen, out = set(), []
    for r in roots:
        if os.path.isdir(r):
            real = os.path.realpath(r)
            if real not in seen:
                seen.add(real)
                out.append(Path(r))
    return out


def libraries(root):
    """The library folders of one Steam root, the root itself first."""
    libs = [root]
    for key, value in pairs(root / "steamapps" / "libraryfolders.vdf"):
        if key == "path":
            libs.append(Path(value))
    return libs


def game_in(library):
    """Momentum's game folder in one library, or None."""
    for acf in sorted((library / "steamapps").glob("appmanifest_*.acf")):
        kv = dict(pairs(acf))
        if "momentum" in kv.get("name", "").lower() and kv.get("installdir"):
            game = library / "steamapps" / "common" / kv["installdir"] / GAME_SUBDIR
            if (game / "cfg").is_dir():
                return game
    return None


def find_game():
    """Momentum's game folder as a str, or None if it isn't installed where Steam keeps games."""
    if os.environ.get("MOMENTUM_DIR"):
        return os.environ["MOMENTUM_DIR"]
    seen = set()
    for root in steam_roots():
        for lib in libraries(root):
            real = os.path.realpath(lib)
            if real in seen:
                continue
            seen.add(real)
            game = game_in(lib)
            if game:
                return str(game)
    return None


def data_dir():
    """Where Strafe Review keeps its files: %LOCALAPPDATA%\\strafe-review on Windows,
    $XDG_DATA_HOME/strafe-review (~/.local/share/strafe-review) elsewhere."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser(r"~\AppData\Local")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return Path(base) / "strafe-review"


if __name__ == "__main__":
    print(find_game())
