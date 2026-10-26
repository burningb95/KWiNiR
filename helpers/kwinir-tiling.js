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
    struts: { left: 0, right: 0, top: 0, bottom: 0 },   // px kept clear on every tiling output
    portraitVertical: true,           // portrait outputs scroll vertically (rows) instead of columns
    portraitDockStrip: 8,             // extra px kept clear at the bottom of portrait outputs (a dock's hover strip)
    centerSingle: false,              // a lone column sits centred
    expandSingle: false,              // a lone column fills the working area
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
// vertical: the strip runs top to bottom (portrait outputs) and a column's windows sit side by
// side; everything below is written in main axis (along the strip) / cross axis (across it).
// weights: window id -> relative size across the strip axis (missing = 1).
function makeStrip() { return { columns: [], focusedColumn: 0, scrollX: 0, lastLayout: null, vertical: false, weights: {} }; }

function resetWeights(strip, col) {
    for (var i = 0; i < col.windows.length; i++) delete strip.weights[wid(col.windows[i])];
}

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

// Dropped window: its own column at idx (clamped), focused.
function stripInsertColumn(strip, w, idx, frac) {
    var at = clamp(idx, 0, strip.columns.length);
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
    delete strip.weights[wid(w)];
    resetWeights(strip, col);
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
    resetWeights(strip, src); resetWeights(strip, dst); delete strip.weights[wid(w)];
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
    resetWeights(strip, src); delete strip.weights[wid(w)];
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

function stripToggleMaximize(strip, colIndex) {
    var col = strip.columns[colIndex === undefined ? strip.focusedColumn : colIndex];
    if (!col) return false;
    if (col.prevFrac === null) { col.prevFrac = col.frac; col.frac = 1; }
    else { col.frac = col.prevFrac; col.prevFrac = null; }
    return true;
}

function mainLen(strip, area) { return strip.vertical ? area.height : area.width; }
function crossLen(strip, area) { return strip.vertical ? area.width : area.height; }
function minMain(w, vertical) { var m = w.minSize; return m ? (vertical ? m.height : m.width) : 0; }

function stripSetWidthPx(strip, colIndex, px, area, c) {
    var col = strip.columns[colIndex];
    if (!col) return false;
    var usable = mainLen(strip, area) - 2 * c.gap;
    col.frac = clamp((px + c.gap) / (usable + c.gap), 0.1, 1);
    col.prevFrac = null;
    return true;
}

// Size of a column along the strip axis, px. vertical: the strip runs top to bottom.
// fracOverride: used for a lone column that expands to fill the area.
function columnWidthPx(col, area, c, vertical, fracOverride) {
    var usable = (vertical ? area.height : area.width) - 2 * c.gap;
    var frac = fracOverride === undefined ? col.frac : fracOverride;
    var px = Math.round(frac * (usable + c.gap) - c.gap);
    for (var i = 0; i < col.windows.length; i++) {
        var m = minMain(col.windows[i], vertical);
        if (m > px) px = m;
    }
    return clamp(px, 1, usable);
}

// [{x, w}] along the strip axis (0 = start of the working area): "x" is the main-axis offset.
function columnXs(strip, area, c) {
    var out = [], x = c.gap;
    var lone = c.expandSingle && strip.columns.length === 1 ? 1 : undefined;
    for (var i = 0; i < strip.columns.length; i++) {
        var w = columnWidthPx(strip.columns[i], area, c, strip.vertical, lone);
        out.push({ x: x, w: w });
        x += w + c.gap;
    }
    return out;
}

// scrollX that brings column idx fully into view. prevIdx = the column that was focused
// before, used by "on-overflow": centre only if the old and new columns can't both fit.
function scrollFor(strip, area, c, idx, prevIdx) {
    var xs = columnXs(strip, area, c), len = mainLen(strip, area);
    var col = xs[idx];
    if (!col) return strip.scrollX;
    var centred = col.x + col.w / 2 - len / 2;
    if (c.center === "always" || (c.centerSingle && strip.columns.length === 1)) return Math.round(centred);
    var left = col.x - c.gap, right = col.x + col.w + c.gap, scroll = strip.scrollX;
    if (left >= scroll && right <= scroll + len) return scroll;
    if (c.center === "on-overflow") {
        var prev = xs[prevIdx];
        var spanL = prev ? Math.min(left, prev.x - c.gap) : left;
        var spanR = prev ? Math.max(right, prev.x + prev.w + c.gap) : right;
        if (spanR - spanL > len) return Math.round(centred);
    }
    return left < scroll ? left : right - len;
}

// Sizes of a column's windows across the strip axis, px (weights -> px, gaps between).
function stackSizes(strip, col, cross, c) {
    var n = col.windows.length, total = cross - 2 * c.gap - c.gap * (n - 1);
    var wts = [], sum = 0, i;
    for (i = 0; i < n; i++) { wts.push(strip.weights[wid(col.windows[i])] || 1); sum += wts[i]; }
    var out = [], used = 0;
    for (i = 0; i < n; i++) {
        var px = i === n - 1 ? total - used : Math.floor(total * wts[i] / sum);
        out.push(px);
        used += px;
    }
    return out;
}

// Pure: where every window goes. A column is visible only if fully inside the viewport
// (a partly visible one would bleed onto the neighbouring monitor).
function computeLayout(strip, area, c) {
    var v = !!strip.vertical, M = mainLen(strip, area), X = crossLen(strip, area);
    var xs = columnXs(strip, area, c), out = [];
    for (var i = 0; i < strip.columns.length; i++) {
        var col = strip.columns[i], n = col.windows.length;
        var viewM = xs[i].x - strip.scrollX;
        var visible = viewM >= c.gap - 1 && viewM + xs[i].w <= M - c.gap + 1;
        var sizes = stackSizes(strip, col, X, c), at = c.gap;
        for (var r = 0; r < n; r++) {
            var m = Math.round(viewM);
            out.push({
                window: col.windows[r], column: i, row: r, visible: visible,
                rect: v ? { x: Math.round(area.x + at), y: Math.round(area.y + m), width: sizes[r], height: xs[i].w }
                        : { x: Math.round(area.x + m), y: Math.round(area.y + at), width: xs[i].w, height: sizes[r] }
            });
            at += sizes[r] + c.gap;
        }
    }
    return out;
}

// Interactive resize, pure. start/cur: the dragged window's frame before and after (any
// {x, y, width, height}). entries: computeLayout() of the strip when the drag began. Dragging
// the edge shared with a fully visible neighbour moves that edge: the neighbour gives up (or
// takes) exactly what the dragged window gains, so the pair keeps its span and nothing else
// has to leave the viewport. An outer edge resizes just the dragged column. The result is
//   { cols: [{c, px}], weights: {id: px} | null }   (null/empty: nothing to change)
function planResize(strip, area, c, at, start, cur, entries) {
    var v = !!strip.vertical, TH = 2;
    var plan = { cols: [], weights: null };
    var m0 = v ? start.y : start.x, mw0 = v ? start.height : start.width;
    var m1 = v ? cur.y : cur.x, mw1 = v ? cur.height : cur.width;
    var x0 = v ? start.x : start.y, xw0 = v ? start.width : start.height;
    var x1 = v ? cur.x : cur.y, xw1 = v ? cur.width : cur.height;
    var xs = columnXs(strip, area, c), len = mainLen(strip, area);
    var minPx = function (col) {
        var frac = Math.round(0.1 * (len - 2 * c.gap + c.gap) - c.gap);
        return Math.max(frac, 1, Math.max.apply(null, col.windows.map(function (w) { return minMain(w, v); })));
    };

    // main axis (column width / row height in a vertical strip)
    var dS = m1 - m0, dE = (m1 + mw1) - (m0 + mw0);
    var grow = 0, nb = -1;
    if (Math.abs(dE) >= TH && Math.abs(dS) < TH) { grow = dE; nb = at.c + 1; }
    else if (Math.abs(dS) >= TH && Math.abs(dE) < TH) { grow = -dS; nb = at.c - 1; }
    if (grow !== 0) {
        var wD = xs[at.c].w, dragged = strip.columns[at.c];
        var nbVisible = nb >= 0 && nb < strip.columns.length;
        if (nbVisible) {
            var vis = false;
            for (var i = 0; i < entries.length; i++) if (entries[i].column === nb) { vis = entries[i].visible; break; }
            nbVisible = vis;
        }
        var newD = Math.max(wD + grow, minPx(dragged));
        if (nbVisible) {
            var nbCol = strip.columns[nb], wN = xs[nb].w;
            var give = newD - wD;                         // what the neighbour loses
            give = Math.min(give, wN - minPx(nbCol));
            newD = wD + give;
            if (newD < minPx(dragged)) { newD = minPx(dragged); give = newD - wD; }
            plan.cols.push({ c: nb, px: wN - give });
        }
        plan.cols.push({ c: at.c, px: newD });
    }

    // cross axis (height of a window in a stack / width of one in a vertical strip)
    var cS = x1 - x0, cE = (x1 + xw1) - (x0 + xw0);
    var cg = 0, rn = -1;
    if (Math.abs(cE) >= TH && Math.abs(cS) < TH) { cg = cE; rn = at.r + 1; }
    else if (Math.abs(cS) >= TH && Math.abs(cE) < TH) { cg = -cS; rn = at.r - 1; }
    var col = strip.columns[at.c];
    if (cg !== 0 && rn >= 0 && rn < col.windows.length) {
        var sizes = stackSizes(strip, col, crossLen(strip, area), c), MIN = 60;
        var d = clamp(cg, -(sizes[at.r] - MIN), sizes[rn] - MIN);
        var wts = {};
        for (var r = 0; r < col.windows.length; r++) wts[wid(col.windows[r])] = sizes[r];
        wts[wid(col.windows[at.r])] = sizes[at.r] + d;
        wts[wid(col.windows[rn])] = sizes[rn] - d;
        plan.weights = wts;
    }
    return plan;
}

function applyPlan(strip, area, c, plan) {
    var changed = false;
    for (var i = 0; i < plan.cols.length; i++)
        changed = stripSetWidthPx(strip, plan.cols[i].c, plan.cols[i].px, area, c) || changed;
    if (plan.weights) {
        for (var id in plan.weights) strip.weights[id] = plan.weights[id];
        changed = true;
    }
    return changed;
}

// Where a dropped window (centre at centreM along the strip axis, relative to the area) lands
// among the existing columns: the number of columns whose midpoint lies before it.
function dropIndex(strip, area, c, centreM) {
    var xs = columnXs(strip, area, c), n = 0, pos = centreM + strip.scrollX;
    for (var i = 0; i < xs.length; i++) if (xs[i].x + xs[i].w / 2 < pos) n++;
    return n;
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
    interactive: {},   // window id -> {start, resizing, strip, at, area, entries, cur} during a user move/resize
    dragId: null,      // id of the window being dragged (live resize preview)
    geomDirty: {},     // window id -> window whose geometry changed outside our writes
    fixes: {},         // window id -> {n, t0}: re-assert attempts, capped so we never fight a client
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

// cfg.outputs with "@primary" resolved to KWin's priority-1 output (screenOrder[0]) and "@all"
// to every screen.
function tilingOutputNames() {
    var out = [];
    for (var i = 0; i < cfg.outputs.length; i++) {
        var n = cfg.outputs[i];
        if (n === "@all") {
            for (var k = 0; k < workspace.screens.length; k++)
                if (out.indexOf(workspace.screens[k].name) < 0) out.push(workspace.screens[k].name);
            continue;
        }
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
    var a = workspace.clientArea(KWin.MaximizeArea, out, desk), st = cfg.struts;
    var g = out.geometry, portrait = g.height > g.width, vertical = cfg.portraitVertical && portrait;
    if (vertical !== strip.vertical) { strip.vertical = vertical; strip.scrollX = 0; }
    var bottom = st.bottom + (portrait ? cfg.portraitDockStrip : 0);
    return { x: a.x + st.left, y: a.y + st.top,
             width: a.width - st.left - st.right, height: a.height - st.top - bottom };
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
    if (!tilingOutput(out) || !outputByName(out)) return null;
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
    // A window born maximized (or maximized by the user) keeps KWin's maximize flag when we
    // resize it, and KWin re-applies maximize geometry when the work area changes: clear it.
    if (w.maximizeMode) w.setMaximize(false, false);
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

var previewTimer = null, previewArmed = false;   // live neighbour follow during a border drag
var geomTimer = null;                            // debounce for geometry changes we did not make
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

// An output went away (monitor off / cable pulled) or stopped tiling: its windows join the
// first tiling output that still exists; with none left they are released and float.
function migrateStrips() {
    if (!state.started || state.released) return;
    var live = tilingOutputNames().filter(function (n) { return outputByName(n) !== null; });
    var stale = [];
    for (var key in state.strips) {
        var strip = state.strips[key];
        if (!outputByName(strip.outputName) || !tilingOutput(strip.outputName)) stale.push(strip);
    }
    for (var i = 0; i < stale.length; i++) {
        var wins = [];
        for (var c = 0; c < stale[i].columns.length; c++)
            for (var r = 0; r < stale[i].columns[c].windows.length; r++)
                wins.push(stale[i].columns[c].windows[r]);
        for (var j = 0; j < wins.length; j++) {
            untile(wins[j]);
            if (live.length && !wins[j].deleted) tile(wins[j], live[0]);
        }
        delete state.strips[stale[i].key];
    }
    if (stale.length) log("output change: moved " + stale.length + " strip(s) to " + (live.length ? live[0] : "nowhere (floating)"));
}

function onScreensChanged() {
    migrateStrips();
    reconcile();
    scheduleReport();
}

function wireWindow(w) {
    var id = wid(w);
    if (state.wired[id]) return;
    state.wired[id] = true;
    // Bar / dock surfaces change the usable area when they move or resize: re-lay out.
    if (w.dock || (w.skipTaskbar && w.onAllDesktops))
        w.frameGeometryChanged.connect(guard("areaChanged", scheduleLayout));
    else
        w.frameGeometryChanged.connect(guard("geometryChanged", function () {
            var i = wid(w);
            if (state.applying || state.released || !state.started || state.interactive[i] || !state.byWin[i]) return;
            state.geomDirty[i] = w;
            if (geomTimer) geomTimer.start();   // restarting it debounces a burst into one check
        }));
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
        // KWin maximize on a tiled window means "maximize ITS column" (not the focused one).
        w.setMaximize(false, false);
        var strip = stripOf(w), at = strip ? stripFind(strip, w) : null;
        if (!at) return;
        var prev = strip.focusedColumn;
        stripFocusWindow(strip, w);
        stripToggleMaximize(strip, at.c);
        reveal(strip, prev);
        layoutAll(w);
    }));
    w.tileChanged.connect(guard("tileChanged", function () {
        if (!w.tile || state.released || !state.started || !stripOf(w)) return;
        quickTilePressed(w);
    }));
    w.interactiveMoveResizeStarted.connect(guard("moveStarted", function () {
        var g = w.frameGeometry, strip = stripOf(w);
        var rec = { start: { x: g.x, y: g.y, width: g.width, height: g.height }, resizing: w.resize === true,
                    body: dragStartedInBody(w),
                    strip: strip, at: null, area: null, entries: null, cur: null };
        if (strip) {
            rec.at = stripFind(strip, w);
            rec.area = workArea(strip);
            rec.entries = rec.area ? computeLayout(strip, rec.area, cfg) : null;
        }
        state.interactive[wid(w)] = rec;
        state.dragId = wid(w);
    }));
    if (w.interactiveMoveResizeStepped)
        w.interactiveMoveResizeStepped.connect(guard("moveStepped", function (geometry) {
            var rec = state.interactive[wid(w)];
            if (!rec || !rec.resizing || !rec.entries || !geometry) return;
            rec.cur = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
            if (previewTimer && !previewArmed) { previewArmed = true; previewTimer.start(); }
        }));
    w.interactiveMoveResizeFinished.connect(guard("moveFinished", function () {
        var i = wid(w), rec = state.interactive[i], g = w.frameGeometry;
        delete state.interactive[i];
        if (state.dragId === i) state.dragId = null;
        var strip = stripOf(w);
        if (!rec || !strip || state.released) { scheduleLayout(); return; }
        var cur = { x: g.x, y: g.y, width: g.width, height: g.height };
        if (rec.resizing) finishResize(w, strip, rec, cur);
        else finishMove(w, strip, rec, cur);
    }));
}

// A client that resizes or moves itself (restoring a saved size, leaving fullscreen) leaves its
// tile looking "reverted". If a visible tiled window sits off its slot for good, put it back;
// at most 3 times per 5 s so a window that insists on its own size is never fought forever.
function verifyGeometry(w) {
    var id = wid(w), strip = stripOf(w);
    if (!strip || w.deleted || w.minimized || w.fullScreen || state.interactive[id] || state.released) return;
    if (strip.desktopId !== workspace.currentDesktop.id) return;
    var lay = strip.lastLayout || [], e = null;
    for (var i = 0; i < lay.length; i++) if (wid(lay[i].window) === id) { e = lay[i]; break; }
    if (!e || !e.visible) return;
    var g = w.frameGeometry, r = e.rect;
    if (Math.abs(g.x - r.x) <= 3 && Math.abs(g.y - r.y) <= 3
            && Math.abs(g.width - r.width) <= 40 && Math.abs(g.height - r.height) <= 40
            && !w.maximizeMode) return;
    var now = Date.now(), f = state.fixes[id];
    if (!f || now - f.t0 > 5000) f = state.fixes[id] = { n: 0, t0: now };
    if (f.n >= 3) return;
    f.n++;
    log("re-asserting " + String(w.resourceClass).slice(0, 40) + " (" + Math.round(g.width) + "x" + Math.round(g.height)
        + "+" + Math.round(g.x) + "+" + Math.round(g.y) + " -> " + r.width + "x" + r.height + "+" + r.x + "+" + r.y + ")");
    delete state.lastRect[id];
    state.applying = true;
    try { writeGeometry(w, r); } finally { state.applying = false; }
}

function verifyDirty() {
    var dirty = state.geomDirty;
    state.geomDirty = {};
    for (var id in dirty) if (!dirty[id].deleted) verifyGeometry(dirty[id]);
}

function cloneStrip(strip) {
    var cp = makeStrip(), id;
    cp.focusedColumn = strip.focusedColumn; cp.scrollX = strip.scrollX; cp.vertical = strip.vertical;
    for (id in strip.weights) cp.weights[id] = strip.weights[id];
    cp.columns = strip.columns.map(function (col) {
        return { windows: col.windows.slice(), frac: col.frac, prevFrac: col.prevFrac, focusedIndex: col.focusedIndex };
    });
    return cp;
}

// A drag that began inside the window (not on its title bar) is a modifier drag: Meta+left
// button, or whatever KWin's Window Actions are set to. Server-decorated windows have a known
// title bar (client area starts below it); client-decorated ones are assumed to have a header
// bar of up to 48 px. A keyboard-started move warps the pointer to the centre: also "body".
function dragStartedInBody(w) {
    var p = workspace.cursorPos, f = w.frameGeometry, c = w.clientGeometry;
    if (!p || !c || p.x < f.x || p.x > f.x + f.width || p.y < f.y || p.y > f.y + f.height) return false;
    var deco = c.y - f.y, head = deco > 1 ? deco + 6 : 48;
    return p.y - f.y >= head;
}

// The monitor next to `fromName` in a direction ("left"|"right"|"up"|"down"), among the
// monitors that tile; null when there is none. Neighbours must overlap along the other axis.
function neighbourOutput(fromName, dir) {
    var from = outputByName(fromName), best = null, bestGap = 1e9;
    if (!from) return null;
    var a = from.geometry, names = tilingOutputNames();
    for (var i = 0; i < names.length; i++) {
        var o = outputByName(names[i]);
        if (!o || o.name === fromName) continue;
        var b = o.geometry, gap;
        if (dir === "left" || dir === "right") {
            if (b.y >= a.y + a.height || b.y + b.height <= a.y) continue;
            gap = dir === "left" ? a.x - (b.x + b.width) : b.x - (a.x + a.width);
        } else {
            if (b.x >= a.x + a.width || b.x + b.width <= a.x) continue;
            gap = dir === "up" ? a.y - (b.y + b.height) : b.y - (a.y + a.height);
        }
        if (gap >= -2 && gap < bestGap) { best = o.name; bestGap = gap; }
    }
    return best;
}

// Takes `w` out of its strip and drops it into `target` as its own column at idx.
function moveToStrip(w, target, idx, frac) {
    var i = wid(w), old = untile(w);
    if (old) reveal(old, old.focusedColumn);
    var at = stripInsertColumn(target, w, idx, frac);
    state.byWin[i] = target.key;
    forgetRects(target);
    reveal(target, at);
    layoutAll(w);
}

// KWin's quick-tile keys (Meta+arrows) snap a window to half the screen, which fights the strip
// (it used to jump there and be put back, or hop monitors). On a tiled window they now mean
// "move this way": along the strip / within the stack, and past the end onto the next monitor.
function quickTilePressed(w) {
    var strip = stripOf(w), t = w.tile, o = w.output;
    if (!strip || !o) return;
    var a = t.absoluteGeometry, g = o.geometry, dir = null;
    var rw = a.width / g.width, rh = a.height / g.height;
    var cx = (a.x + a.width / 2 - g.x) / g.width, cy = (a.y + a.height / 2 - g.y) / g.height;
    if (rw < 0.75 && (rh >= 0.75 || Math.abs(cx - 0.5) >= Math.abs(cy - 0.5))) dir = cx < 0.5 ? "left" : "right";
    else if (rh < 0.75) dir = cy < 0.5 ? "up" : "down";
    w.tile = null;           // KWin puts the frame back where it was
    if (!dir) { forgetRects(strip); layoutAll(w); return; }
    stripFocusWindow(strip, w);
    var d = dir === "left" || dir === "up" ? -1 : 1, prev = strip.focusedColumn;
    var moved = dirIsMain(strip, dir) ? stripMoveColumn(strip, d) : stripMoveRow(strip, d);
    if (moved) { reveal(strip, prev); forgetRects(strip); layoutAll(w); return; }
    var hop = neighbourOutput(strip.outputName, dir);
    if (!hop || !w.desktops || w.desktops.length !== 1) { forgetRects(strip); layoutAll(w); return; }
    var at = stripFind(strip, w), solo = at && strip.columns[at.c].windows.length === 1;
    var frac = solo ? strip.columns[at.c].frac : cfg.defaultWidth;
    var target = getStrip(hop, w.desktops[0].id, true);
    // it arrives at the edge it came in from: past the end going left/up, at the start going right/down
    moveToStrip(w, target, d < 0 ? target.columns.length : 0, frac);
}

// While a border is dragged, the neighbour it pushes against follows live (the dragged window
// is KWin's to move). Nothing is hidden or minimized until the drag ends.
function previewResize() {
    var rec = state.dragId !== null ? state.interactive[state.dragId] : null;
    if (!rec || !rec.resizing || !rec.cur || !rec.strip || !rec.at || state.released) return;
    var strip = rec.strip, area = workArea(strip);
    if (!area) return;
    var plan = planResize(strip, area, cfg, rec.at, rec.start, rec.cur, rec.entries);
    var cp = cloneStrip(strip);
    if (!applyPlan(cp, area, cfg, plan)) return;
    var was = {}, i;
    for (i = 0; i < rec.entries.length; i++) was[wid(rec.entries[i].window)] = rec.entries[i];
    var entries = computeLayout(cp, area, cfg);
    state.applying = true;
    try {
        for (i = 0; i < entries.length; i++) {
            var e = entries[i], id = wid(e.window), before = was[id];
            if (id === state.dragId || !e.visible || !before || !before.visible || e.window.deleted) continue;
            if (rectKey(e.rect) !== rectKey(before.rect)) writeGeometry(e.window, e.rect);
        }
    } finally { state.applying = false; }
}

function forgetRects(strip) {
    for (var c = 0; c < strip.columns.length; c++)
        for (var r = 0; r < strip.columns[c].windows.length; r++)
            delete state.lastRect[wid(strip.columns[c].windows[r])];
}

function finishResize(w, strip, rec, cur) {
    var area = workArea(strip), at = stripFind(strip, w);
    if (area && at) {
        var entries = rec.entries || computeLayout(strip, area, cfg);
        applyPlan(strip, area, cfg, planResize(strip, area, cfg, at, rec.start, cur, entries));
    }
    forgetRects(strip);
    reveal(strip, strip.focusedColumn);
    layoutAll(w);
}

// A dragged tiled window re-enters the strip where it was dropped: on the monitor it ended up
// on, in the slot its centre falls in. Two things float it instead: a drag that began inside the
// window rather than on its title bar (Meta/Alt + left button), and a drop on a monitor that
// does not tile (it stays where it was dropped).
function finishMove(w, strip, rec, cur) {
    var i = wid(w), travelled = Math.abs(cur.x - rec.start.x) + Math.abs(cur.y - rec.start.y);
    var out = w.output;
    var tileable = out && tilingOutput(out.name) && w.desktops && w.desktops.length === 1;
    if (rec.body || (travelled >= 6 && !tileable)) {
        state.floating[i] = true;
        untile(w);
        reveal(strip, strip.focusedColumn);
        layoutAll(w);
        return;
    }
    if (travelled < 6 || !tileable) { forgetRects(strip); layoutAll(w); return; }
    var at = stripFind(strip, w), solo = at && strip.columns[at.c].windows.length === 1;
    var frac = solo ? strip.columns[at.c].frac : cfg.defaultWidth;
    var target = getStrip(out.name, w.desktops[0].id, true), area = workArea(target);
    if (!area) { forgetRects(strip); layoutAll(w); return; }
    untile(w);
    reveal(strip, strip.focusedColumn);
    var centre = target.vertical ? cur.y + cur.height / 2 - area.y : cur.x + cur.width / 2 - area.x;
    var at2 = stripInsertColumn(target, w, dropIndex(target, area, cfg, centre), frac);
    state.byWin[i] = target.key;
    forgetRects(target);
    reveal(target, at2);
    layoutAll(w);
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
    delete state.geomDirty[id]; delete state.fixes[id];
    if (state.dragId === id) state.dragId = null;
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

// Directional commands follow the screen: in a vertical (portrait) strip up/down run along the
// strip and left/right move between the windows side by side in one row.
function dirIsMain(strip, dir) {
    return strip.vertical ? (dir === "up" || dir === "down") : (dir === "left" || dir === "right");
}

function focusDir(dir) {
    return withStrip(function (s) {
        var d = dir === "left" || dir === "up" ? -1 : 1;
        return dirIsMain(s, dir) ? stripFocusColumn(s, d) : stripFocusRow(s, d);
    });
}

function moveDir(dir) {
    return withStrip(function (s) {
        var d = dir === "left" || dir === "up" ? -1 : 1;
        return dirIsMain(s, dir) ? stripMoveColumn(s, d) : stripMoveRow(s, d);
    });
}

var COMMANDS = {
    "focus-left": function () { return focusDir("left"); },
    "focus-right": function () { return focusDir("right"); },
    "focus-up": function () { return focusDir("up"); },
    "focus-down": function () { return focusDir("down"); },
    "move-column-left": function () { return moveDir("left"); },
    "move-column-right": function () { return moveDir("right"); },
    "move-window-up": function () { return moveDir("up"); },
    "move-window-down": function () { return moveDir("down"); },
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
            s.scrollX = Math.round(c.x + c.w / 2 - mainLen(s, area) / 2);
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
    if (c.struts && typeof c.struts === "object") {
        var st = { left: cfg.struts.left, right: cfg.struts.right, top: cfg.struts.top, bottom: cfg.struts.bottom };
        ["left", "right", "top", "bottom"].forEach(function (k) {
            if (typeof c.struts[k] === "number" && c.struts[k] >= 0 && c.struts[k] <= 512) st[k] = Math.round(c.struts[k]);
        });
        cfg.struts = st;
    }
    if (typeof c.portraitDockStrip === "number" && c.portraitDockStrip >= 0 && c.portraitDockStrip <= 200)
        cfg.portraitDockStrip = Math.round(c.portraitDockStrip);
    if (typeof c.portraitVertical === "boolean") cfg.portraitVertical = c.portraitVertical;
    if (typeof c.centerSingle === "boolean") cfg.centerSingle = c.centerSingle;
    if (typeof c.expandSingle === "boolean") cfg.expandSingle = c.expandSingle;
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
        var span = last && area ? Math.max(1, last.x + last.w + cfg.gap - mainLen(strip, area)) : 1;
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
            desktop: strip.desktopId, focusedColumn: strip.focusedColumn, vertical: strip.vertical === true,
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

    previewTimer = new QTimer();
    previewTimer.singleShot = true;
    previewTimer.interval = 40;
    previewTimer.timeout.connect(guard("previewTimer", function () { previewArmed = false; previewResize(); }));

    geomTimer = new QTimer();
    geomTimer.singleShot = true;
    geomTimer.interval = 250;
    geomTimer.timeout.connect(guard("geomTimer", verifyDirty));

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
    workspace.screensChanged.connect(guard("screensChanged", onScreensChanged));
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
