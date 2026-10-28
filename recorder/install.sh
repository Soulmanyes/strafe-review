#!/bin/sh
# Copy the recorder into Momentum's custom/ folder and add our block to cfg/autoexec.cfg.
# Undo with uninstall.sh.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
game="${MOMENTUM_DIR:-$HOME/.local/share/Steam/steamapps/common/Momentum Mod Playtest/momentum}"
dest="$game/custom/strafe-review"
autoexec="$game/cfg/autoexec.cfg"

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

# yaw.log is the same name Source Yaw's yaws.cfg uses; only one con_logfile is active, so both tools share it.
# engine_no_focus_sleep 0 keeps full fps while tabbed out, so replays record every tick.
touch "$autoexec"
[ -e "$autoexec.bak-strafe-review" ] || cp "$autoexec" "$autoexec.bak-strafe-review"
tmp=$(mktemp "$autoexec.XXXXXX")
sed '/^\/\/ strafe-review begin$/,/^\/\/ strafe-review end$/d' "$autoexec" > "$tmp"
cat >> "$tmp" <<'CFG'
// strafe-review begin
con_logfile yaw.log
engine_no_focus_sleep 0
// strafe-review end
CFG
mv "$tmp" "$autoexec"
echo "updated $autoexec"
