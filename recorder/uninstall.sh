#!/bin/sh
# Remove the recorder from Momentum's custom/ folder and our block from cfg/autoexec.cfg.
set -eu
game="${MOMENTUM_DIR:-$HOME/.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum}"
autoexec="$game/cfg/autoexec.cfg"
rm -rf "$game/custom/strafe-review"
echo "removed $game/custom/strafe-review"
if [ -e "$autoexec" ]; then
	sed -i '/^\/\/ strafe-review begin$/,/^\/\/ strafe-review end$/d' "$autoexec"
	echo "removed the strafe-review block from $autoexec"
fi
