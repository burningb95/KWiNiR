#!/bin/sh
# Put back the Plasma wallpapers that were active before KWiNiR first set one
# (saved by services/Wallpapers.qml to plasma-wallpaper-original.json).
# Each screen gets its original image in its original wallpaper plugin.
set -e
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/quickshell/user/plasma-wallpaper-original.json"
[ -s "$STATE" ] || { echo "nothing saved at $STATE" >&2; exit 1; }
SAVED=$(cat "$STATE")
gdbus call --session --dest org.kde.plasmashell --object-path /PlasmaShell \
    --method org.kde.PlasmaShell.evaluateScript "var saved = $SAVED;
desktops().forEach(function (d) {
    saved.forEach(function (s) {
        if (s.screen !== d.screen) return;
        d.wallpaperPlugin = s.plugin;
        d.currentConfigGroup = ['Wallpaper', s.plugin, 'General'];
        d.writeConfig('Image', s.image);
        d.reloadConfig();
    });
});" >/dev/null
echo "restored wallpapers from $STATE"
