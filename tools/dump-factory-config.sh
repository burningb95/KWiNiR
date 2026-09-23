#!/bin/sh
# Regenerate defaults/inir-factory-config.json: the config that Config.qml
# writes when no file exists, i.e. every option at its code default.
# Runs the settings window offscreen against an empty XDG_CONFIG_HOME, so
# nothing appears on screen and the real ~/.config/pillbar is never read.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
XDG_CONFIG_HOME="$TMP" QT_QPA_PLATFORM=offscreen timeout 8 /usr/bin/qs -n -p "$ROOT/settings.qml" >/dev/null 2>&1 || true
[ -s "$TMP/pillbar/config.json" ] || { echo "no config was written" >&2; exit 1; }
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$TMP/pillbar/config.json"
cp "$TMP/pillbar/config.json" "$ROOT/defaults/inir-factory-config.json"
echo "wrote $ROOT/defaults/inir-factory-config.json"
