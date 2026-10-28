"""Update check against Strafe Review's GitHub releases. Only the standard library.

check() asks GitHub for the latest release at most every CHECK_EVERY seconds and remembers the
answer in <data_dir>/updates.json (the same keys as the owner's other apps: auto, checked, latest,
installed, failed). install() is for the Windows exe only: it downloads the release zip, puts the
new exe next to the running one and swaps them (a running exe can be renamed, not overwritten);
the new version runs from the next start, which the server does right away. A copy running from
the repo (Linux, or Python on Windows) only reports updates: git pull brings them.
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

import steam

VERSION = "1.0.1"  # bump in the same commit as the release tag
REPO = "Soulmanyes/strafe-review"
ASSET = "strafe-review-windows.zip"
EXE = "strafe-review.exe"
CHECK_EVERY = 6 * 3600  # seconds between automatic checks
TIMEOUT = 10
# Tests point this at a local server; it answers like GitHub's releases/latest
API = os.environ.get("STRAFE_REVIEW_UPDATE_API", f"https://api.github.com/repos/{REPO}/releases/latest")
STATE_FILE = steam.data_dir() / "updates.json"


def parse_version(text):
    """"v1.4.0" or "1.4" -> (1, 4, 0); None if it isn't a plain version number."""
    parts = (text or "").strip().lstrip("vV").split(".")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    return tuple(nums + [0] * (3 - len(nums)))


def frozen_exe():
    """The running program when it is a PyInstaller build (the Windows exe; a Linux build only in
    tests), else None."""
    return Path(sys.executable) if getattr(sys, "frozen", False) else None


class Updater:
    def __init__(self, state_file=STATE_FILE, version=VERSION):
        self.version = version
        self.state_file = Path(state_file)
        self.state = self._load()
        # an update that was installed but isn't what runs now didn't take: don't retry it on its own
        tag = self.state.get("installed")
        if tag and parse_version(tag) != parse_version(version):
            self.state.update(failed=tag)
            self.state.pop("installed", None)
            self._save()
        elif tag:
            self.state.pop("installed", None)
            self._save()

    def _load(self):
        try:
            state = json.loads(self.state_file.read_text())
            return state if isinstance(state, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self):
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=2) + "\n")
        tmp.replace(self.state_file)

    @property
    def auto(self):
        return bool(self.state.get("auto"))

    @auto.setter
    def auto(self, value):
        self.state["auto"] = bool(value)
        self._save()

    @property
    def can_install(self):
        return frozen_exe() is not None

    def newer(self, latest):
        mine, theirs = parse_version(self.version), parse_version(latest and latest.get("tag"))
        return bool(mine and theirs and theirs > mine)

    def failed(self, latest):
        return self.state.get("failed") == latest["tag"]

    def info(self):
        """What the page shows: this version, the latest release if newer, and whether it can install."""
        latest = self.state.get("latest")
        return {
            "version": self.version,
            "latest": latest if self.newer(latest) else None,
            "checked": self.state.get("checked"),
            "auto": self.auto,
            "canInstall": self.can_install,
            "failed": self.state.get("failed"),
            "error": self.state.get("error"),
        }

    def check(self, force=False):
        """The latest release as {"tag", "url", "asset"} if newer than this version, else None. Asks
        GitHub only when forced or CHECK_EVERY after the last check. Raises OSError/ValueError when
        GitHub can't be reached (the error is kept for the page too)."""
        latest = self.state.get("latest")
        if force or not latest or time.time() - self.state.get("checked", 0) > CHECK_EVERY:
            req = urllib.request.Request(API, headers={"Accept": "application/vnd.github+json",
                                                       "User-Agent": "strafe-review"})
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                    data = json.load(r)
                asset = next((a["browser_download_url"] for a in data.get("assets", []) if a.get("name") == ASSET), None)
                latest = {"tag": data["tag_name"], "url": data.get("html_url", ""), "asset": asset}
            except (OSError, ValueError, KeyError, TypeError) as e:
                self.state.update(error=f"{type(e).__name__}: {e}", checked=time.time())
                self._save()
                raise OSError(str(e)) from e
            self.state.update(latest=latest, checked=time.time())
            self.state.pop("error", None)
            self._save()
        return latest if self.newer(latest) else None

    def install(self, latest):
        """Swap in the release's exe. Raises RuntimeError with a message for the page when that fails."""
        try:
            self._install(latest)
        except (OSError, RuntimeError, zipfile.BadZipFile) as e:
            self.state["failed"] = latest["tag"]
            self._save()
            raise RuntimeError(str(e)) from e
        self.state["installed"] = latest["tag"]
        self.state.pop("failed", None)
        self._save()

    def _install(self, latest):
        exe = frozen_exe()
        if exe is None:
            raise RuntimeError("This copy runs from the repo: update it with git pull")
        if not latest.get("asset"):
            raise RuntimeError(f"Release {latest['tag']} has no {ASSET}")
        new, old = exe.with_name(exe.name + ".new"), exe.with_name(exe.name + ".old")
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / ASSET
            req = urllib.request.Request(latest["asset"], headers={"User-Agent": "strafe-review"})
            with urllib.request.urlopen(req, timeout=120) as r, open(archive, "wb") as f:
                shutil.copyfileobj(r, f)
            with zipfile.ZipFile(archive) as z:
                names = {EXE, exe.name.lower()}
                name = next((n for n in z.namelist() if n.rsplit("/", 1)[-1].lower() in names), None)
                if not name:
                    raise RuntimeError(f"The release zip has no {EXE}")
                with z.open(name) as src, open(new, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        old.unlink(missing_ok=True)
        new.chmod(exe.stat().st_mode)
        exe.rename(old)  # Windows lets a running exe be renamed, not replaced
        try:
            new.rename(exe)
        except OSError:
            old.rename(exe)
            raise


def clean_old():
    """Delete the exe an earlier update left behind. The old copy may still be ending when the new one
    starts, so this keeps trying for a while in the background."""
    exe = frozen_exe()
    if not exe:
        return

    def run():
        old = exe.with_name(exe.name + ".old")
        for _ in range(60):
            try:
                old.unlink(missing_ok=True)
                return
            except OSError:
                time.sleep(1)

    threading.Thread(target=run, daemon=True).start()
