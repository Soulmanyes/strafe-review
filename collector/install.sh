#!/bin/sh
# Link strafe-review-run into ~/.local/bin; it starts this repo's viewer/server.py, so
# keep the repo where it is. Then set Momentum Mod's Steam launch options to:
#   strafe-review-run sourceyaw-run %command%
# Undo with: install.sh --uninstall
set -eu
here=$(cd "$(dirname "$0")" && pwd)
link="$HOME/.local/bin/strafe-review-run"
if [ "${1:-}" = "--uninstall" ]; then
	rm -f "$link"
	echo "removed $link; take strafe-review-run out of the launch options too"
	exit
fi
mkdir -p "$HOME/.local/bin"
ln -sfn "$here/strafe-review-run" "$link"
echo "linked $link"
