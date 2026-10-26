// SPDX-License-Identifier: GPL-3.0-or-later
// KWiNiR scrolling tiling: niri-style columns on KWin. Loaded at runtime through
// org.kde.kwin.Scripting.loadScript (never installed into KWin's config) as the script
// "kwinir-tiling". Plan: docs/TILING_PLAN.md. Undo: tools/tiling-rescue.sh.
//
// Layout: a strip per (output, virtual desktop) holds columns; a column holds one or more
// windows stacked vertically. The strip scrolls horizontally so the focused column is in
// view. KWin will not park a window fully off the monitors, so columns that are not
// fully inside the viewport are MINIMIZED (plan decision D1) and restored when scrolled
// back. Only windows this script minimized are ever restored by it.
//
// Sections: Config · Pure model/layout (no KWin calls, unit-tested by
// tools/tiling-test.mjs) · KWin glue · Commands · Command channel · Startup.

// ---------------------------------------------------------------- Config
var DEFAULTS = {
    gap: 12,                          // px, between columns/windows and around the strip
    defaultWidth: 0.5,                // new column, fraction of the working width
    presetWidths: [0.3333, 0.5, 0.6667],
    center: "on-overflow",            // "never" | "on-overflow" | "always"
    outputs: ["@primary"],            // outputs that tile; "@primary" = KWin's priority-1 output
    onlyClasses: null,                // null = every tileable window, else a whitelist
    floatClasses: [
        "org.kde.spectacle", "org.kde.krunner", "org.kde.plasmashell", "plasmashell",
        "org.kde.polkit-kde-authentication-agent-1", "org.kde.kwalletd5", "org.kde.kwalletd6",
        "org.kde.kwalletmanager", "org.kde.latte-dock", "org.kde.klipper", "xwaylandvideobridge",
        "org.kde.kscreenlocker_greet", "steam_app_*", "pinentry*", "kwinir-float*"
    ],
    bottomMargin: 0,                  // px kept clear at the bottom of a tiling output
    shortcutPrefix: "KWiNiR Tiling: ",
    shortcuts: true,
    // The bridge (helpers/kwinir_bridge.py) owns both: commands arrive by long-poll, state
    // reports go out as Event calls. tools/tiling-try.sh points `command` at a test daemon.
    command: { service: "org.kwinir.Bridge", path: "/Bridge", iface: "org.kwinir.Bridge" },
    event: { service: "org.kwinir.Bridge", path: "/Bridge", iface: "org.kwinir.Bridge" },
    autostart: false                  // false: stay idle until the bridge sends `config`
};

var cfg = (function () {
    var out = {}, k;
    for (k in DEFAULTS) out[k] = DEFAULTS[k];
    if (typeof KWINIR_OVERRIDE !== "undefined")
        for (k in KWINIR_OVERRIDE) out[k] = KWINIR_OVERRIDE[k];
    return out;
})();

// ---------------------------------------------------------------- Pure model / layout
function wid(w) { return String(w.internalId); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function makeColumn(frac) { return { windows: [], frac: frac, prevFrac: null, focusedIndex: 0 }; }
function makeStrip() { return { columns: [], focusedColumn: 0, scrollX: 0, lastLayout: null }; }

function stripFind(strip, w) {
    var id = wid(w);
    for (var c = 0; c < strip.columns.length; c++)
        for (var r = 0; r < strip.columns[c].windows.length; r++)
            if (wid(strip.columns[c].windows[r]) === id)
                return { c: c, r: r };
    return null;
}

function stripFocusedWindow(strip) {
    var col = strip.columns[strip.focusedColumn];
    return col ? col.windows[col.focusedIndex] || null : null;
}

function stripCount(strip) {
    var n = 0;
    for (var c = 0; c < strip.columns.length; c++) n += strip.columns[c].windows.length;
    return n;
}

// New window: its own column, right of the focused one, and it takes focus.
function stripAdd(strip, w, frac) {
    var at = strip.columns.length ? strip.focusedColumn + 1 : 0;
    var col = makeColumn(frac);
    col.windows.push(w);
    strip.columns.splice(at, 0, col);
    strip.focusedColumn = at;
    return at;
}

function stripRemove(strip, w) {
    var at = stripFind(strip, w);
    if (!at) return false;
    var col = strip.columns[at.c];
    col.windows.splice(at.r, 1);
    if (col.focusedIndex >= col.windows.length) col.focusedIndex = Math.max(0, col.windows.length - 1);
    else if (col.focusedIndex > at.r) col.focusedIndex--;
    if (!col.windows.length) {
        strip.columns.splice(at.c, 1);
        if (strip.focusedColumn > at.c || strip.focusedColumn >= strip.columns.length)
            strip.focusedColumn = Math.max(0, strip.focusedColumn - 1);
    }
    return true;
}

function stripFocusWindow(strip, w) {
    var at = stripFind(strip, w);
    if (!at) return false;
    strip.focusedColumn = at.c;
    strip.columns[at.c].focusedIndex = at.r;
    return true;
}

function stripFocusColumn(strip, delta) {
    var n = clamp(strip.focusedColumn + delta, 0, strip.columns.length - 1);
    if (!strip.columns.length || n === strip.focusedColumn) return false;
    strip.focusedColumn = n;
    return true;
}

function stripFocusRow(strip, delta) {
    var col = strip.columns[strip.focusedColumn];
    if (!col) return false;
    var n = clamp(col.focusedIndex + delta, 0, col.windows.length - 1);
    if (n === col.focusedIndex) return false;
    col.focusedIndex = n;
    return true;
}

function stripMoveColumn(strip, delta) {
    var a = strip.focusedColumn, b = a + delta;
    if (b < 0 || b >= strip.columns.length) return false;
    var t = strip.columns[a]; strip.columns[a] = strip.columns[b]; strip.columns[b] = t;
    strip.focusedColumn = b;
    return true;
}

function stripMoveRow(strip, delta) {
    var col = strip.columns[strip.focusedColumn];
    if (!col) return false;
    var a = col.focusedIndex, b = a + delta;
    if (b < 0 || b >= col.windows.length) return false;
    var t = col.windows[a]; col.windows[a] = col.windows[b]; col.windows[b] = t;
    col.focusedIndex = b;
    return true;
}

// Focused window joins the neighbouring column (bottom of the left one, top of the right one).
function stripConsume(strip, delta) {
    var from = strip.focusedColumn, to = from + delta;
    var src = strip.columns[from], dst = strip.columns[to];
    if (!src || !dst) return false;
    var w = src.windows.splice(src.focusedIndex, 1)[0];
    var row = delta < 0 ? dst.windows.length : 0;
    dst.windows.splice(row, 0, w);
    dst.focusedIndex = row;
    if (src.focusedIndex >= src.windows.length) src.focusedIndex = Math.max(0, src.windows.length - 1);
    if (!src.windows.length) {
        strip.columns.splice(from, 1);
        to = delta < 0 ? to : to - 1;
    }
    strip.focusedColumn = to;
    return true;
}

// Focused window leaves a multi-window column for a new column on the given side.
function stripExpel(strip, delta, frac) {
    var src = strip.columns[strip.focusedColumn];
    if (!src || src.windows.length < 2) return false;
    var w = src.windows.splice(src.focusedIndex, 1)[0];
    if (src.focusedIndex >= src.windows.length) src.focusedIndex = src.windows.length - 1;
    var col = makeColumn(frac);
    col.windows.push(w);
    var at = delta < 0 ? strip.focusedColumn : strip.focusedColumn + 1;
    strip.columns.splice(at, 0, col);
    strip.focusedColumn = at;
    return true;
}

function stripConsumeOrExpel(strip, delta, frac) {
    var col = strip.columns[strip.focusedColumn];
    if (!col) return false;
    return col.windows.length > 1 ? stripExpel(strip, delta, frac) : stripConsume(strip, delta);
}

function stripCycleWidth(strip, presets) {
    var col = strip.columns[strip.focusedColumn];
    if (!col) return false;
    var next = presets[0];
    for (var i = 0; i < presets.length; i++)
        if (presets[i] > col.frac + 0.01) { next = presets[i]; break; }
    col.frac = next;
    col.prevFrac = null;
    return true;
}

function stripToggleMaximize(strip) {
    var col = strip.columns[strip.focusedColumn];
    if (!col) return false;
    if (col.prevFrac === null) { col.prevFrac = col.frac; col.frac = 1; }
    else { col.frac = col.prevFrac; col.prevFrac = null; }
    return true;
}

function stripSetWidthPx(strip, colIndex, px, area, c) {
    var col = strip.columns[colIndex];
    if (!col) return false;
    var usable = area.width - 2 * c.gap;
    col.frac = clamp((px + c.gap) / (usable + c.gap), 0.1, 1);
    col.prevFrac = null;
    return true;
}

function columnWidthPx(col, area, c) {
    var usable = area.width - 2 * c.gap;
    var px = Math.round(col.frac * (usable + c.gap) - c.gap);
    for (var i = 0; i < col.windows.length; i++) {
        var m = col.windows[i].minSize;
        if (m && m.width > px) px = m.width;
    }
    return clamp(px, 1, usable);
}

// [{x, w}] in strip coordinates (0 = left edge of the working area).
function columnXs(strip, area, c) {
    var out = [], x = c.gap;
    for (var i = 0; i < strip.columns.length; i++) {
        var w = columnWidthPx(strip.columns[i], area, c);
        out.push({ x: x, w: w });
        x += w + c.gap;
    }
    return out;
}

// scrollX that brings column idx fully into view. prevIdx = the column that was focused
// before, used by "on-overflow": centre only if the old and new columns can't both fit.
function scrollFor(strip, area, c, idx, prevIdx) {
    var xs = columnXs(strip, area, c);
    var col = xs[idx];
    if (!col) return strip.scrollX;
    var centred = col.x + col.w / 2 - area.width / 2;
    if (c.center === "always") return Math.round(centred);
    var left = col.x - c.gap, right = col.x + col.w + c.gap, scroll = strip.scrollX;
    if (left >= scroll && right <= scroll + area.width) return scroll;
    if (c.center === "on-overflow") {
        var prev = xs[prevIdx];
        var spanL = prev ? Math.min(left, prev.x - c.gap) : left;
        var spanR = prev ? Math.max(right, prev.x + prev.w + c.gap) : right;
        if (spanR - spanL > area.width) return Math.round(centred);
    }
    return left < scroll ? left : right - area.width;
}

// Pure: where every window goes. A column is visible only if fully inside the viewport
// (a partly visible one would bleed onto the neighbouring monitor).
function computeLayout(strip, area, c) {
    var xs = columnXs(strip, area, c), out = [];
    var innerH = area.height - 2 * c.gap;
    for (var i = 0; i < strip.columns.length; i++) {
        var col = strip.columns[i], n = col.windows.length;
        var viewX = xs[i].x - strip.scrollX;
        var visible = viewX >= c.gap - 1 && viewX + xs[i].w <= area.width - c.gap + 1;
        var h = Math.floor((innerH - c.gap * (n - 1)) / n);
        for (var r = 0; r < n; r++) {
            var hh = r === n - 1 ? innerH - (h + c.gap) * (n - 1) : h;
            out.push({
                window: col.windows[r], column: i, row: r, visible: visible,
                rect: {
                    x: Math.round(area.x + viewX), y: Math.round(area.y + c.gap + r * (h + c.gap)),
                    width: xs[i].w, height: hh
                }
            });
        }
    }
    return out;
}

function matchesClass(cls, patterns) {
    cls = String(cls || "").toLowerCase();
    for (var i = 0; i < patterns.length; i++) {
        var p = String(patterns[i]).toLowerCase();
        if (p.charAt(p.length - 1) === "*" ? cls.indexOf(p.slice(0, -1)) === 0 : cls === p)
            return true;
    }
    return false;
}

// ---------------------------------------------------------------- KWin glue
var KWIN_ENV = typeof workspace !== "undefined" && typeof workspace.windowList === "function";

var state = {
    strips: {},        // key "output|desktopId" -> strip (+ outputName, desktopId)
    byWin: {},         // window id -> strip key
    floating: {},      // window id -> true when the user floated it (never auto-tiled)
    scriptMin: {},     // window id -> true when WE minimized it
    expectMin: {},     // window id -> value we just set, so the signal is not mistaken for the user
    lastRect: {},      // window id -> "x,y,w,h" last written
    interactive: {},   // window id -> geometry at start of a user move/resize
    wired: {},         // window id -> true once per-window signals are connected
    applying: false,
    pendingLayout: false,
    released: false,
    lastActive: null,
    started: false,      // false until the bridge's `config` arrives (or cfg.autostart)
    lastReport: ""
};

function log(msg) { print("TILING " + msg); }

function guard(name, fn) {
    return function () {
        try { return fn.apply(null, arguments); }
        catch (e) { log("ERROR in " + name + ": " + e + (e && e.stack ? " @ " + String(e.stack).split("\n")[0] : "")); }
    };
}

// cfg.outputs with "@primary" resolved to KWin's priority-1 output (screenOrder[0]).
function tilingOutputNames() {
    var out = [];
    for (var i = 0; i < cfg.outputs.length; i++) {
        var n = cfg.outputs[i];
        if (n === "@primary") n = workspace.screenOrder && workspace.screenOrder.length ? workspace.screenOrder[0].name : "";
        if (n && out.indexOf(n) < 0) out.push(n);
    }
    return out;
}

function tilingOutput(name) { return tilingOutputNames().indexOf(name) >= 0; }

function outputByName(name) {
    var s = workspace.screens;
    for (var i = 0; i < s.length; i++) if (s[i].name === name) return s[i];
    return null;
}

function desktopById(id) {
    var d = workspace.desktops;
    for (var i = 0; i < d.length; i++) if (d[i].id === id) return d[i];
    return null;
}

function stripKey(outName, deskId) { return outName + "|" + deskId; }

function getStrip(outName, deskId, create) {
    var key = stripKey(outName, deskId), s = state.strips[key];
    if (!s && create) {
        s = makeStrip();
        s.key = key; s.outputName = outName; s.desktopId = deskId;
        state.strips[key] = s;
    }
    return s || null;
}

function workArea(strip) {
    var out = outputByName(strip.outputName), desk = desktopById(strip.desktopId);
    if (!out || !desk) return null;
    var a = workspace.clientArea(KWin.MaximizeArea, out, desk);
    return { x: a.x, y: a.y, width: a.width, height: a.height - cfg.bottomMargin };
}

function isTileable(w) {
    if (!w || w.deleted || !w.managed) return false;
    if (!w.normalWindow || w.skipTaskbar || w.dialog || w.transient || w.specialWindow
            || w.popupWindow || w.dock || w.desktopWindow) return false;
    if (w.onAllDesktops || !w.desktops || w.desktops.length !== 1) return false;
    if (!w.resizeable || !w.moveable || !w.output) return false;
    if (matchesClass(w.resourceClass, cfg.floatClasses)) return false;
    if (cfg.onlyClasses && !matchesClass(w.resourceClass, cfg.onlyClasses)) return false;
    return true;
}

function setMinimized(w, value) {
    if (w.minimized === value) return;
    state.expectMin[wid(w)] = value;
    w.minimized = value;
}

function releaseWindow(w) {
    var id = wid(w);
    if (state.scriptMin[id]) {
        delete state.scriptMin[id];
        if (!w.deleted) setMinimized(w, false);
    }
    delete state.lastRect[id];
}

function untile(w) {
    var id = wid(w), key = state.byWin[id];
    if (key === undefined) return null;
    var strip = state.strips[key];
    if (strip) stripRemove(strip, w);
    delete state.byWin[id];
    releaseWindow(w);
    return strip;
}

// Adds w to the strip of (output, its desktop). Returns the strip or null.
function tile(w, outName) {
    if (state.released || !state.started || state.floating[wid(w)] || !isTileable(w)) return null;
    var out = outName || w.output.name;
    if (!tilingOutput(out)) return null;
    var strip = getStrip(out, w.desktops[0].id, true);
    if (stripFind(strip, w)) return strip;
    var prev = strip.focusedColumn;
    stripAdd(strip, w, cfg.defaultWidth);
    state.byWin[wid(w)] = strip.key;
    strip.scrollX = scrollFor(strip, workArea(strip) || { width: 1000, height: 1000, x: 0, y: 0 }, cfg,
                              strip.focusedColumn, prev);
    return strip;
}

function reveal(strip, prevIdx) {
    var area = workArea(strip);
    if (area) strip.scrollX = scrollFor(strip, area, cfg, strip.focusedColumn, prevIdx);
}

function rectKey(r) { return r.x + "," + r.y + "," + r.width + "," + r.height; }

function writeGeometry(w, rect) {
    var id = wid(w), key = rectKey(rect), g = w.frameGeometry;
    // Sizes are not compared with the live value: terminals snap to their cell grid.
    if (state.lastRect[id] === key && Math.abs(g.x - rect.x) < 2 && Math.abs(g.y - rect.y) < 2)
        return;
    state.lastRect[id] = key;
    w.frameGeometry = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

// Applies the model to KWin for every strip on the current desktop. focusTarget: window to
// leave focused; null keeps the focus the user had (re-activating it if a minimize stole it).
function layoutAll(focusTarget) {
    if (state.released || !state.started) return;
    if (state.applying) { state.pendingLayout = true; return; }
    state.applying = true;
    var before = workspace.activeWindow, target = focusTarget || null;
    try {
        var cur = workspace.currentDesktop;
        for (var key in state.strips) {
            var strip = state.strips[key];
            if (strip.desktopId !== cur.id) continue;
            var area = workArea(strip);
            if (!area) continue;
            var entries = computeLayout(strip, area, cfg);
            strip.lastLayout = entries;
            var hide = [];
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i], w = e.window, id = wid(w);
                if (w.deleted || state.interactive[id] || w.fullScreen) continue;
                if (e.visible) {
                    if (state.scriptMin[id]) { delete state.scriptMin[id]; setMinimized(w, false); }
                    if (!w.minimized) writeGeometry(w, e.rect);
                } else {
                    hide.push(w);
                }
            }
            for (var j = 0; j < hide.length; j++) {
                if (!hide[j].minimized) { setMinimized(hide[j], true); state.scriptMin[wid(hide[j])] = true; }
            }
            if (!target && before && state.byWin[wid(before)] === strip.key)
                target = entriesVisible(entries, before) ? before : stripFocusedWindow(strip);
        }
    } finally {
        state.applying = false;
    }
    if (target && !target.deleted && workspace.activeWindow !== target) {
        state.applying = true;
        try { workspace.activeWindow = target; } finally { state.applying = false; }
    }
    if (state.pendingLayout) { state.pendingLayout = false; scheduleLayout(); }
    scheduleReport();
}

function entriesVisible(entries, w) {
    var id = wid(w);
    for (var i = 0; i < entries.length; i++)
        if (wid(entries[i].window) === id) return entries[i].visible;
    return false;
}

var layoutTimer = null, layoutTimerArmed = false;
function scheduleLayout() {
    if (!layoutTimer || layoutTimerArmed) return;
    layoutTimerArmed = true;
    layoutTimer.start();
}

// KWin picks the next active window itself after a close, in its own recent-use order and
// possibly after our windowRemoved handler ran. A moment later, if focus left the strip the
// closed window belonged to, put it back on that strip's focused column.
var refocusTimer = null, refocusKey = null;
function scheduleRefocus(key) {
    if (!refocusTimer) return;
    refocusKey = key;
    refocusTimer.start();
}

function doRefocus() {
    var strip = refocusKey !== null ? state.strips[refocusKey] : null;
    refocusKey = null;
    if (!strip || state.released) return;
    var aw = workspace.activeWindow, target = stripFocusedWindow(strip);
    if (target && !target.deleted && !(aw && stripOf(aw) === strip)) {
        reveal(strip, strip.focusedColumn);
        layoutAll(target);
    }
}

function stripOf(w) {
    var key = state.byWin[wid(w)];
    return key === undefined ? null : state.strips[key] || null;
}

// Window moved desktop/output (or became tileable/untileable): redo its membership.
function retile(w) {
    if (state.released) return;
    var old = stripOf(w);
    var wasKey = old ? old.key : null;
    untile(w);
    var s = tile(w);
    if (s || wasKey) scheduleLayout();
}

function wireWindow(w) {
    var id = wid(w);
    if (state.wired[id]) return;
    state.wired[id] = true;
    w.desktopsChanged.connect(guard("desktopsChanged", function () {
        if (!state.applying) retile(w);
    }));
    w.outputChanged.connect(guard("outputChanged", function () {
        if (state.applying || state.interactive[wid(w)]) return;
        var s = stripOf(w);
        if (s && w.output && w.output.name !== s.outputName) retile(w);
        else if (!s) retile(w);
    }));
    w.minimizedChanged.connect(guard("minimizedChanged", function () {
        var i = wid(w), expected = state.expectMin[i];
        if (expected !== undefined) {
            delete state.expectMin[i];
            if (expected === w.minimized) return;
        }
        if (state.applying || state.released) return;
        if (w.minimized) {
            // The user minimized a tiled window: it leaves the strip until restored.
            if (stripOf(w)) { delete state.scriptMin[i]; untile(w); scheduleLayout(); }
        } else if (state.scriptMin[i]) {
            // Un-minimized behind our back (taskbar / Alt+Tab): it was activated, which
            // scrolls it into view. Forget that we hid it.
            delete state.scriptMin[i];
        } else if (!stripOf(w)) {
            retile(w);
        }
    }));
    w.fullScreenChanged.connect(guard("fullScreenChanged", function () {
        if (!w.fullScreen) scheduleLayout();
    }));
    w.maximizedChanged.connect(guard("maximizedChanged", function () {
        if (state.applying || !stripOf(w) || !w.maximizeMode) return;
        // KWin maximize on a tiled window means "maximize the column" (decided in Phase 3).
        w.setMaximize(false, false);
        runCommand("maximize-column");
    }));
    w.interactiveMoveResizeStarted.connect(guard("moveStarted", function () {
        var g = w.frameGeometry;
        state.interactive[wid(w)] = { x: g.x, y: g.y, width: g.width, height: g.height };
    }));
    w.interactiveMoveResizeFinished.connect(guard("moveFinished", function () {
        var i = wid(w), start = state.interactive[i], g = w.frameGeometry;
        delete state.interactive[i];
        var strip = stripOf(w);
        if (!start || !strip) return;
        var resized = Math.abs(g.width - start.width) > 3;
        var moved = Math.abs(g.x - start.x) > 3 || Math.abs(g.y - start.y) > 3;
        if (resized) {
            var at = stripFind(strip, w), area = workArea(strip);
            if (at && area) stripSetWidthPx(strip, at.c, g.width, area, cfg);
            delete state.lastRect[i];
            reveal(strip, strip.focusedColumn);
            layoutAll(w);
        } else if (moved) {
            // v1: dragging a tiled window floats it where it was dropped.
            state.floating[i] = true;
            untile(w);
            scheduleLayout();
        }
    }));
}

function onWindowAdded(w) {
    wireWindow(w);
    var s = tile(w);
    if (s) layoutAll(w);
    else scheduleLayout();
}

function onWindowRemoved(w) {
    var id = wid(w), strip = stripOf(w), wasActive = state.lastActive === id;
    if (strip) {
        stripRemove(strip, w);
        delete state.byWin[id];
    }
    delete state.scriptMin[id]; delete state.lastRect[id]; delete state.expectMin[id];
    delete state.interactive[id]; delete state.wired[id]; delete state.floating[id];
    if (strip) {
        reveal(strip, strip.focusedColumn);
        layoutAll(wasActive ? stripFocusedWindow(strip) : null);
        if (wasActive) scheduleRefocus(strip.key);
    } else {
        scheduleLayout();
    }
}

function onWindowActivated(w) {
    state.lastActive = w ? wid(w) : null;
    if (!w || state.released) return;
    var strip = stripOf(w);
    if (!strip) return;
    var prev = strip.focusedColumn;
    if (!stripFocusWindow(strip, w)) return;
    reveal(strip, prev);
    layoutAll(w);
}

// ---------------------------------------------------------------- Commands
function currentStrip() {
    var aw = workspace.activeWindow, s = aw ? stripOf(aw) : null;
    if (s) { stripFocusWindow(s, aw); return s; }   // commands act on what is really focused
    var out = workspace.activeScreen;
    if (out && tilingOutput(out.name)) return getStrip(out.name, workspace.currentDesktop.id, true);
    var names = tilingOutputNames();
    return names.length ? getStrip(names[0], workspace.currentDesktop.id, true) : null;
}

// Mutate the model with fn(strip), then reveal the focused column and apply.
function withStrip(fn, keepScroll) {
    var strip = currentStrip();
    if (!strip) return { ok: false, error: "no strip" };
    var prev = strip.focusedColumn;
    if (!fn(strip)) return { ok: true, changed: false };
    if (!keepScroll) reveal(strip, prev);
    layoutAll(stripFocusedWindow(strip));
    return { ok: true, changed: true };
}

function adoptWindow(w) {
    if (!w || stripOf(w)) return false;
    delete state.floating[wid(w)];
    var target = null, names = tilingOutputNames();
    for (var i = 0; i < names.length && !target; i++)
        if (outputByName(names[i])) target = names[i];
    if (!target) return false;
    // Tile onto the first tiling output when the window sits elsewhere.
    var s = tile(w, w.output && tilingOutput(w.output.name) ? w.output.name : target);
    if (!s) return false;
    layoutAll(w);
    return true;
}

function dumpStrips() {
    var out = [], cur = workspace.currentDesktop, active = workspace.activeWindow;
    for (var key in state.strips) {
        var strip = state.strips[key];
        if (strip.desktopId !== cur.id) continue;
        var area = workArea(strip), want = {}, lay = strip.lastLayout || [];
        for (var i = 0; i < lay.length; i++) want[wid(lay[i].window)] = lay[i];
        var cols = [];
        for (var c = 0; c < strip.columns.length; c++) {
            var col = strip.columns[c], ws = [];
            for (var r = 0; r < col.windows.length; r++) {
                var w = col.windows[r], g = w.frameGeometry, e = want[wid(w)];
                ws.push({
                    id: wid(w), caption: w.caption, cls: w.resourceClass, minimized: w.minimized,
                    active: active === w, output: w.output && w.output.name,
                    actual: { x: Math.round(g.x), y: Math.round(g.y), width: Math.round(g.width), height: Math.round(g.height) },
                    want: e ? e.rect : null, visible: e ? e.visible : null
                });
            }
            cols.push({ frac: col.frac, focusedIndex: col.focusedIndex, windows: ws });
        }
        out.push({ key: key, output: strip.outputName, area: area, scrollX: strip.scrollX,
                   focusedColumn: strip.focusedColumn, columns: cols });
    }
    return out;
}

function activeInfo() {
    var a = workspace.activeWindow;
    return a ? { cls: a.resourceClass, caption: a.caption, id: wid(a) } : null;
}

function releaseAll() {
    var n = 0;
    state.released = true;
    var list = workspace.windowList();
    for (var i = 0; i < list.length; i++) {
        var w = list[i];
        if (state.scriptMin[wid(w)]) { delete state.scriptMin[wid(w)]; setMinimized(w, false); n++; }
    }
    state.strips = {}; state.byWin = {};
    sendReport(true);
    return n;
}

var COMMANDS = {
    "focus-left": function () { return withStrip(function (s) { return stripFocusColumn(s, -1); }); },
    "focus-right": function () { return withStrip(function (s) { return stripFocusColumn(s, 1); }); },
    "focus-up": function () { return withStrip(function (s) { return stripFocusRow(s, -1); }); },
    "focus-down": function () { return withStrip(function (s) { return stripFocusRow(s, 1); }); },
    "move-column-left": function () { return withStrip(function (s) { return stripMoveColumn(s, -1); }); },
    "move-column-right": function () { return withStrip(function (s) { return stripMoveColumn(s, 1); }); },
    "move-window-up": function () { return withStrip(function (s) { return stripMoveRow(s, -1); }); },
    "move-window-down": function () { return withStrip(function (s) { return stripMoveRow(s, 1); }); },
    "consume-left": function () { return withStrip(function (s) { return stripConsume(s, -1); }); },
    "consume-right": function () { return withStrip(function (s) { return stripConsume(s, 1); }); },
    "expel": function () { return withStrip(function (s) { return stripExpel(s, 1, cfg.defaultWidth); }); },
    "consume-or-expel-left": function () {
        return withStrip(function (s) { return stripConsumeOrExpel(s, -1, cfg.defaultWidth); });
    },
    "consume-or-expel-right": function () {
        return withStrip(function (s) { return stripConsumeOrExpel(s, 1, cfg.defaultWidth); });
    },
    "cycle-width": function () { return withStrip(function (s) { return stripCycleWidth(s, cfg.presetWidths); }); },
    "maximize-column": function () { return withStrip(function (s) { return stripToggleMaximize(s); }); },
    "center-column": function () {
        return withStrip(function (s) {
            var area = workArea(s), xs = area && columnXs(s, area, cfg), c = xs && xs[s.focusedColumn];
            if (!c) return false;
            s.scrollX = Math.round(c.x + c.w / 2 - area.width / 2);
            return true;
        }, true);
    },
    "float-toggle": function () {
        var w = workspace.activeWindow;
        if (!w) return { ok: false, error: "no active window" };
        var strip = stripOf(w);
        if (strip) {
            state.floating[wid(w)] = true;
            untile(w);
            reveal(strip, strip.focusedColumn);
            layoutAll(w);   // floating a window must not move the focus
            return { ok: true, floating: true };
        }
        return { ok: adoptWindow(w), floating: false };
    },
    "adopt": function (arg) {
        // adopt [class]: tile the active window, or every untiled tileable window of a class.
        if (!arg) return { ok: adoptWindow(workspace.activeWindow) };
        var list = workspace.windowList(), n = 0;
        for (var i = 0; i < list.length; i++)
            if (list[i].resourceClass === arg && isTileable(list[i]) && adoptWindow(list[i])) n++;
        return { ok: true, adopted: n };
    },
    "focus-column": function (arg) {
        return withStrip(function (s) {
            var n = clamp(Number(arg) | 0, 0, s.columns.length - 1);
            if (!s.columns.length || n === s.focusedColumn) return false;
            s.focusedColumn = n;
            return true;
        });
    },
    "config": function (arg) { return { ok: applyConfig(arg) }; },
    "relayout": function () { layoutAll(null); return { ok: true }; },
    "dump": function () { return { ok: true, strips: dumpStrips(), active: activeInfo() }; },
    "windows": function (arg) {
        // debug: real KWin state of every normal window of a class (no titles beyond caption)
        var list = workspace.windowList(), out = [];
        for (var i = 0; i < list.length; i++) {
            var w = list[i];
            if (!w.normalWindow || w.skipTaskbar || (arg && w.resourceClass !== arg)) continue;
            out.push({ id: wid(w), cls: w.resourceClass, minimized: w.minimized, tiled: stripOf(w) !== null });
        }
        return { ok: true, windows: out };
    },
    "release-all": function () { return { ok: true, restored: releaseAll() }; }
};

var IDLE_OK = { "config": 1, "dump": 1, "windows": 1, "release-all": 1 };

function runCommand(name, arg) {
    var fn = COMMANDS[name];
    if (!fn) return { ok: false, error: "unknown command" };
    if (!state.started && !IDLE_OK[name]) return { ok: false, error: "not configured yet" };
    try { return fn(arg) || { ok: true }; }
    catch (e) { log("ERROR in command " + name + ": " + e); return { ok: false, error: String(e) }; }
}

var SHORTCUTS = [
    { text: "Focus column left", key: "Meta+Alt+H", cmd: "focus-left" },
    { text: "Focus column left (arrow)", key: "Ctrl+Alt+Left", cmd: "focus-left" },
    { text: "Focus column right", key: "Meta+Alt+L", cmd: "focus-right" },
    { text: "Focus column right (arrow)", key: "Ctrl+Alt+Right", cmd: "focus-right" },
    { text: "Focus window down", key: "Meta+Alt+J", cmd: "focus-down" },
    { text: "Focus window down (arrow)", key: "Ctrl+Alt+Down", cmd: "focus-down" },
    { text: "Focus window up", key: "Meta+Alt+K", cmd: "focus-up" },
    { text: "Focus window up (arrow)", key: "Ctrl+Alt+Up", cmd: "focus-up" },
    { text: "Move column left", key: "Meta+Alt+Shift+H", cmd: "move-column-left" },
    { text: "Move column right", key: "Meta+Alt+Shift+L", cmd: "move-column-right" },
    { text: "Move window down", key: "Meta+Alt+Shift+J", cmd: "move-window-down" },
    { text: "Move window up", key: "Meta+Alt+Shift+K", cmd: "move-window-up" },
    { text: "Consume or expel window left", key: "Meta+Alt+[", cmd: "consume-or-expel-left" },
    { text: "Consume or expel window right", key: "Meta+Alt+]", cmd: "consume-or-expel-right" },
    { text: "Cycle column width", key: "Meta+Alt+R", cmd: "cycle-width" },
    { text: "Maximize column", key: "Meta+Alt+F", cmd: "maximize-column" },
    { text: "Center column", key: "Meta+Alt+C", cmd: "center-column" },
    { text: "Toggle floating", key: "Meta+Alt+V", cmd: "float-toggle" }
];

// ---------------------------------------------------------------- Config from the bridge
function strList(v, maxItems, maxLen) {
    if (!Array.isArray(v) || v.length > maxItems) return null;
    var out = [];
    for (var i = 0; i < v.length; i++) {
        if (typeof v[i] !== "string" || v[i].length === 0 || v[i].length > maxLen) return null;
        out.push(v[i]);
    }
    return out;
}

function numList(v, maxItems) {
    if (!Array.isArray(v) || v.length < 1 || v.length > maxItems) return null;
    var out = [];
    for (var i = 0; i < v.length; i++) {
        if (typeof v[i] !== "number" || !(v[i] >= 0.1 && v[i] <= 1)) return null;
        out.push(v[i]);
    }
    return out;
}

// Validates field by field (the bridge validates too); unknown or bad fields are ignored.
function applyConfig(c) {
    if (!c || typeof c !== "object") return false;
    if (typeof c.gap === "number" && c.gap >= 0 && c.gap <= 100) cfg.gap = Math.round(c.gap);
    if (typeof c.defaultWidth === "number" && c.defaultWidth >= 0.1 && c.defaultWidth <= 1) cfg.defaultWidth = c.defaultWidth;
    var presets = numList(c.presetWidths, 8);
    if (presets) cfg.presetWidths = presets;
    if (c.center === "never" || c.center === "on-overflow" || c.center === "always") cfg.center = c.center;
    if (typeof c.bottomMargin === "number" && c.bottomMargin >= 0 && c.bottomMargin <= 400) cfg.bottomMargin = Math.round(c.bottomMargin);
    var outs = strList(c.outputs, 8, 64);
    if (outs && outs.length) cfg.outputs = outs;
    if (c.onlyClasses === null) cfg.onlyClasses = null;
    else { var only = strList(c.onlyClasses, 200, 100); if (only) cfg.onlyClasses = only.length ? only : null; }
    var fl = strList(c.floatClasses, 200, 100);
    if (fl) cfg.floatClasses = fl;
    if (typeof c.shortcuts === "boolean") cfg.shortcuts = c.shortcuts;
    begin();
    return true;
}

// Config changed: drop windows that no longer belong (output or class lists), adopt new ones.
function reconcile() {
    var list = workspace.windowList();
    for (var i = 0; i < list.length; i++) {
        var w = list[i], s = stripOf(w);
        if (s && (!tilingOutput(s.outputName) || !isTileable(w))) untile(w);
        else if (!s && !w.minimized) tile(w);
    }
    for (var key in state.strips) {
        var strip = state.strips[key];
        if (strip.columns.length) reveal(strip, strip.focusedColumn);
    }
    layoutAll(null);
}

// ---------------------------------------------------------------- State report
// One snapshot per change, debounced (docs/TILING_PLAN.md §2.4). No window titles: they are
// untrusted text. The bridge rebuilds the object from checked fields before the bar sees it.
function buildReport() {
    var rep = { type: "tiling", v: 1, enabled: state.started && !state.released, outputs: {} };
    if (!rep.enabled) return rep;
    var cur = workspace.currentDesktop, active = workspace.activeWindow;
    for (var key in state.strips) {
        var strip = state.strips[key];
        if (strip.desktopId !== cur.id) continue;
        var area = workArea(strip), vis = {}, lay = strip.lastLayout || [];
        for (var i = 0; i < lay.length; i++) vis[wid(lay[i].window)] = lay[i].visible;
        var xs = area ? columnXs(strip, area, cfg) : [], last = xs.length ? xs[xs.length - 1] : null;
        var span = last && area ? Math.max(1, last.x + last.w + cfg.gap - area.width) : 1;
        var cols = [];
        for (var c = 0; c < strip.columns.length; c++) {
            var col = strip.columns[c], ws = [];
            for (var r = 0; r < col.windows.length; r++) {
                var w = col.windows[r];
                ws.push({ id: wid(w), app: String(w.resourceClass || "").slice(0, 64),
                          focused: c === strip.focusedColumn && r === col.focusedIndex });
            }
            cols.push({ width: Math.round(col.frac * 1000) / 1000,
                        visible: ws.length ? vis[ws[0].id] === true : false, windows: ws });
        }
        rep.outputs[strip.outputName] = {
            desktop: strip.desktopId, focusedColumn: strip.focusedColumn,
            scroll: Math.round(clamp(strip.scrollX / span, 0, 1) * 1000) / 1000, columns: cols
        };
    }
    return rep;
}

var reportTimer = null, reportArmed = false;
function scheduleReport() {
    if (!reportTimer || reportArmed || !cfg.event) return;
    reportArmed = true;
    reportTimer.start();
}

function sendReport(force) {
    if (!cfg.event) return;
    var json = JSON.stringify(buildReport());
    if (!force && json === state.lastReport) return;
    state.lastReport = json;
    callDBus(cfg.event.service, cfg.event.path, cfg.event.iface, "Event", json);
}

// ---------------------------------------------------------------- Command channel
// Long-poll (docs/TILING_PLAN.md §2.3 A): KWin scripts can't export D-Bus methods, so the
// script keeps one NextCommand call open against the owner. The owner must answer within
// ~15 s (a "noop" heartbeat): a held call dies silently at ~25 s with no callback.
function pollCommands() {
    var ch = cfg.command;
    if (!ch) return;
    callDBus(ch.service, ch.path, ch.iface, "NextCommand", guard("poll", function (reply) {
        var msg = null;
        try { msg = JSON.parse(reply); } catch (e) { log("bad command reply: " + reply); }
        if (msg && msg.type === "cmd") {
            var result = runCommand(String(msg.name), msg.arg);
            callDBus(ch.service, ch.path, ch.iface, "Ack", JSON.stringify({ id: msg.id, result: result }));
        }
        pollCommands();   // the channel outlives release-all: the owner unloads us when done
    }));
}

// ---------------------------------------------------------------- Startup
function init() {
    layoutTimer = new QTimer();
    layoutTimer.singleShot = true;
    layoutTimer.interval = 30;
    layoutTimer.timeout.connect(guard("layoutTimer", function () { layoutTimerArmed = false; layoutAll(null); }));

    refocusTimer = new QTimer();
    refocusTimer.singleShot = true;
    refocusTimer.interval = 120;
    refocusTimer.timeout.connect(guard("refocusTimer", doRefocus));

    reportTimer = new QTimer();
    reportTimer.singleShot = true;
    reportTimer.interval = 50;
    reportTimer.timeout.connect(guard("reportTimer", function () { reportArmed = false; sendReport(false); }));

    workspace.windowAdded.connect(guard("windowAdded", onWindowAdded));
    workspace.windowRemoved.connect(guard("windowRemoved", onWindowRemoved));
    workspace.windowActivated.connect(guard("windowActivated", onWindowActivated));
    workspace.currentDesktopChanged.connect(guard("currentDesktopChanged", function () { layoutAll(null); scheduleReport(); }));
    workspace.screensChanged.connect(guard("screensChanged", scheduleLayout));
    workspace.virtualScreenGeometryChanged.connect(guard("virtualScreenGeometryChanged", scheduleLayout));

    var list = workspace.windowList();
    for (var i = 0; i < list.length; i++) wireWindow(list[i]);

    pollCommands();
    if (cfg.autostart) begin();
    else log("loaded, waiting for config from the bridge");
}

// Starts tiling (once): adopts the windows already open, registers the shortcuts.
function begin() {
    if (state.started) { reconcile(); return; }
    state.started = true;
    var list = workspace.windowList().slice();
    list.sort(function (a, b) { return a.frameGeometry.x - b.frameGeometry.x || a.frameGeometry.y - b.frameGeometry.y; });
    for (var i = 0; i < list.length; i++)
        if (!list[i].minimized) tile(list[i]);
    var aw = workspace.activeWindow, as = aw ? stripOf(aw) : null;
    if (as) { stripFocusWindow(as, aw); reveal(as, as.focusedColumn); }

    if (cfg.shortcuts) {
        SHORTCUTS.forEach(function (sc) {
            registerShortcut(cfg.shortcutPrefix + sc.text, cfg.shortcutPrefix + sc.text, sc.key,
                             guard("shortcut " + sc.cmd, function () { runCommand(sc.cmd); }));
        });
    }
    layoutAll(null);
    sendReport(true);
    log("started: outputs=" + tilingOutputNames().join(",") + " tiled=" + Object.keys(state.byWin).length);
}

if (KWIN_ENV) init();
