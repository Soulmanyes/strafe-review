#!/bin/sh
# Copy the recorder into Momentum's custom/ folder. Undo with uninstall.sh.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
game="${MOMENTUM_DIR:-$HOME/.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum}"
dest="$game/custom/strafe-review"

# timer.xml shadows the game's own copy; warn if upstream changed it since we copied it
upstream="$game/panorama/layout/hud/timer.xml"
if [ "$(sha256sum "$upstream" | cut -d' ' -f1)" != "$(cat "$here/timer.xml.upstream.sha256")" ]; then
	echo "warning: the game's timer.xml changed since the copy in recorder/; diff it before playing:" >&2
	echo "  diff \"$upstream\" \"$here/panorama/layout/hud/timer.xml\"" >&2
fi

rm -rf "$dest"
mkdir -p "$dest"
cp -r "$here/panorama" "$dest/"
echo "installed to $dest"
