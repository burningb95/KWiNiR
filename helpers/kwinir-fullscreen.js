// SPDX-License-Identifier: GPL-3.0-or-later
// KWiNiR: tells the bar whether a fullscreen window is visible, for game mode's
// auto-detect. Loaded at runtime by helpers/kwinir_bridge.py through
// org.kde.kwin.Scripting.loadScript — never installed into KWin's config, so it
// disappears when KWin or the bar restarts (the bridge loads it again).
//
// "Visible" = fullscreen, not minimized, on the current virtual desktop. That is
// upstream's semantics on niri (a fullscreen window owning a visible viewport),
// so a game on DP-1 keeps game mode on while focus is on DP-3.

var last = null;

function onCurrentDesktop(w) {
    if (w.onAllDesktops)
        return true;
    var current = workspace.currentDesktop;
    var desktops = w.desktops || [];
    for (var i = 0; i < desktops.length; i++) {
        if (desktops[i] && current && desktops[i].id === current.id)
            return true;
    }
    return false;
}

function fullscreenVisible() {
    var windows = workspace.windowList();
    for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        // Spectacle's region selector is fullscreen too; that's "capture", not a game.
        if (w && w.normalWindow && w.fullScreen && !w.minimized && onCurrentDesktop(w)
                && w.resourceClass !== "org.kde.spectacle")
            return true;
    }
    return false;
}

// Spectacle's region selector (screenshots and region recording) is one
// fullscreen window per output. While it is up, the bar lowers its Overlay
// surfaces (open sidebars, pill panels) beneath it and drops keyboard focus.
var lastCapture = null;

function captureActive() {
    var windows = workspace.windowList();
    for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (w && w.resourceClass === "org.kde.spectacle" && w.fullScreen && !w.minimized)
            return true;
    }
    return false;
}

function report() {
    var capture = captureActive();
    if (capture !== lastCapture) {
        lastCapture = capture;
        callDBus("org.kwinir.Bridge", "/Bridge", "org.kwinir.Bridge", "Event",
                 JSON.stringify({ type: "capture", value: capture }));
    }
    var value = fullscreenVisible();
    if (value === last)
        return;
    last = value;
    callDBus("org.kwinir.Bridge", "/Bridge", "org.kwinir.Bridge", "Event",
             JSON.stringify({ type: "fullscreen", value: value }));
}

function watch(w) {
    if (!w)
        return;
    w.fullScreenChanged.connect(report);
    w.minimizedChanged.connect(report);
    w.desktopsChanged.connect(report);
}

workspace.windowList().forEach(watch);
workspace.windowAdded.connect(function (w) { watch(w); report(); });
workspace.windowRemoved.connect(report);
workspace.currentDesktopChanged.connect(report);
report();
