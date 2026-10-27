#!/bin/sh
# Remove the recorder from Momentum's custom/ folder.
set -eu
game="${MOMENTUM_DIR:-$HOME/.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum}"
rm -rf "$game/custom/strafe-review"
echo "removed $game/custom/strafe-review"
