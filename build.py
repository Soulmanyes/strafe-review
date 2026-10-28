#!/usr/bin/env python3
"""Builds the one-file Strafe Review program with PyInstaller: dist/strafe-review(.exe).

Usage: python build.py   (needs: pip install pyinstaller)

PyInstaller builds for the system it runs on, so the Windows exe is built on Windows
(.github/workflows/windows.yml does it). The bundle keeps the repo layout (collector/, viewer/static/,
recorder/), which collector.ROOT and install.ROOT find through sys._MEIPASS.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def data(src, dest):
    return ["--add-data", f"{ROOT / src}{os.pathsep}{dest}"]


def clean():
    """Tool caches inside the bundled folders would be shipped too."""
    for cache in ROOT.glob("*/**/.ruff_cache"):
        shutil.rmtree(cache)


def main():
    clean()
    cmd = [
        sys.executable, "-m", "PyInstaller", "--onefile", "--noconfirm", "--clean",
        "--name", "strafe-review",
        "--paths", str(ROOT / "collector"), "--paths", str(ROOT / "viewer"),
        *data("viewer/static", "viewer/static"),
        *data("recorder/panorama", "recorder/panorama"),
        str(ROOT / "strafe_review.py"),
    ]
    sys.exit(subprocess.call(cmd, cwd=ROOT))


if __name__ == "__main__":
    main()
