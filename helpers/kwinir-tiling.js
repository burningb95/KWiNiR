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
    regionOutputs: [],                // outputs that use fixed regions (KWin's tile layout) instead of the strip
    regionSplits: {},                 // output -> [base-rect key]: tiles of KWin's layout split top / bottom (Ctrl+Meta+S)
    newWindowOverlay: true,           // a new window opens OVER a tiled one (same cell) instead of getting a cell of its own
    arrowKeysScrollStrips: false,     // Meta+arrow on a scrolling monitor: false = leave it alone, true = move/snap columns
    regionsNewWindow: "smart",        // "smart": same app's slot, else an empty slot, else the focused one | "focused"
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
function makeStrip() { return { columns: [], focusedColumn: 0, scrollX: 0, lastLayout: null, vertical: false, weights: {}, align: null }; }

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


// ---------------------------------------------------------------- Pure: fixed regions
// A zone is the alternative to a strip on an output: the slots are the leaf tiles of KWin's own
// tile layout for that output (System Settings / Meta+T editor), as fractions of the working
// area. A slot holds a stack of windows, split evenly top to bottom. Nothing scrolls, nothing
// is hidden.
function baseKey(r) { return [r.x, r.y, r.w, r.h].map(function (v) { return Math.round(v * 1000) / 1000; }).join(","); }

// KWin's tile rects plus the user's top/bottom splits (a list of baseKeys) -> the slot rects.
// Every rect carries its base key; the halves of a split also carry half: 0 (top) / 1 (bottom).
function zoneDerive(base, splits) {
    var out = [];
    for (var i = 0; i < base.length; i++) {
        var r = base[i], k = baseKey(r);
        if (splits && splits.indexOf(k) >= 0) {
            out.push({ x: r.x, y: r.y, w: r.w, h: r.h / 2, key: k, half: 0 });
            out.push({ x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2, key: k, half: 1 });
        } else {
            out.push({ x: r.x, y: r.y, w: r.w, h: r.h, key: k });
        }
    }
    return out;
}

function makeZone(base, splits) {
    var z = { kind: "zone", slots: [], focusedSlot: 0, lastLayout: null, sig: "", base: base };
    zoneSetRects(z, zoneDerive(base, splits));
    z.focusedSlot = largestSlot(z.slots);
    return z;
}

function zoneSetRects(zone, rects) {
    var old = zone.slots || [];
    zone.slots = rects.map(function (r, i) {
        return { rect: r, windows: old[i] ? old[i].windows : [], focused: old[i] ? old[i].focused : 0 };
    });
    zone.sig = JSON.stringify(rects);
}

function overlapArea(a, b) {
    var w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 1e-9 && h > 1e-9 ? w * h : 0;
}

// The slots changed (a Meta+T edit, or a split / merge): every window moves to the new slot
// that covers its old one. A slot that was cut in two spreads its stack over the halves in
// order (one window goes to the top half); slots that were merged stack in order.
function zoneReseat(zone, rects) {
    var old = zone.slots, focus = zoneFocusedWindow(zone), fresh = [], i, j;
    for (j = 0; j < rects.length; j++) fresh.push({ rect: rects[j], windows: [], focused: 0 });
    for (i = 0; i < old.length; i++) {
        var wins = old[i].windows;
        if (!wins.length) continue;
        var ov = [];
        for (j = 0; j < rects.length; j++) {
            var a = overlapArea(old[i].rect, rects[j]);
            if (a > 0) ov.push({ j: j, a: a });
        }
        if (!ov.length) {                                   // nothing overlaps: the nearest centre
            var cx = old[i].rect.x + old[i].rect.w / 2, cy = old[i].rect.y + old[i].rect.h / 2, bd = 1e9, bj = 0;
            for (j = 0; j < rects.length; j++) {
                var d = Math.pow(rects[j].x + rects[j].w / 2 - cx, 2) + Math.pow(rects[j].y + rects[j].h / 2 - cy, 2);
                if (d < bd) { bd = d; bj = j; }
            }
            ov.push({ j: bj, a: 1 });
        }
        // ignore slivers: a slot counts only if it holds a good share of the old one
        var best = Math.max.apply(null, ov.map(function (o) { return o.a; }));
        ov = ov.filter(function (o) { return o.a >= best * 0.25; });
        if (ov.length === 1 || wins.length === 1 && ov.length < 1) {
            for (var t = 0; t < wins.length; t++) fresh[ov[0].j].windows.push(wins[t]);
        } else {
            ov.sort(function (p, q) { return (rects[p.j].y - rects[q.j].y) || (rects[p.j].x - rects[q.j].x); });
            for (var t2 = 0; t2 < wins.length; t2++)
                fresh[ov[Math.min(Math.floor(t2 * ov.length / wins.length), ov.length - 1)].j].windows.push(wins[t2]);
        }
    }
    zone.slots = fresh;
    zone.sig = JSON.stringify(rects);
    zone.focusedSlot = largestSlot(fresh);
    if (focus) zoneFocusWindow(zone, focus);
    for (j = 0; j < fresh.length; j++)
        if (fresh[j].focused >= fresh[j].windows.length) fresh[j].focused = Math.max(0, fresh[j].windows.length - 1);
}

function largestSlot(slots) {
    var best = 0, area = -1;
    for (var i = 0; i < slots.length; i++) {
        var a = slots[i].rect.w * slots[i].rect.h;
        if (a > area + 1e-9) { area = a; best = i; }
    }
    return best;
}

function zoneFind(zone, w) {
    var id = wid(w);
    for (var s = 0; s < zone.slots.length; s++)
        for (var i = 0; i < zone.slots[s].windows.length; i++)
            if (wid(zone.slots[s].windows[i]) === id) return { s: s, i: i };
    return null;
}

// Every window, slot by slot, top to bottom.
function zoneWindows(zone) {
    var out = [];
    for (var s = 0; s < zone.slots.length; s++)
        for (var i = 0; i < zone.slots[s].windows.length; i++) out.push(zone.slots[s].windows[i]);
    return out;
}

function zoneFocusedWindow(zone) {
    var slot = zone.slots[zone.focusedSlot];
    return slot ? slot.windows[slot.focused] || null : null;
}

// The window goes to the bottom of that slot's stack and takes focus.
function zoneAdd(zone, w, slotIdx) {
    var at = clamp(slotIdx, 0, zone.slots.length - 1), slot = zone.slots[at];
    slot.windows.push(w);
    slot.focused = slot.windows.length - 1;
    zone.focusedSlot = at;
    return at;
}

function zoneRemove(zone, w) {
    var at = zoneFind(zone, w);
    if (!at) return false;
    var slot = zone.slots[at.s];
    slot.windows.splice(at.i, 1);
    if (slot.focused > at.i || slot.focused >= slot.windows.length) slot.focused = Math.max(0, slot.focused - 1);
    return true;
}

function zoneFocusWindow(zone, w) {
    var at = zoneFind(zone, w);
    if (!at) return false;
    zone.focusedSlot = at.s;
    zone.slots[at.s].focused = at.i;
    return true;
}

// Focus moves up / down the focused slot's stack.
function zoneFocusRow(zone, delta) {
    var slot = zone.slots[zone.focusedSlot];
    if (!slot) return false;
    var n = clamp(slot.focused + delta, 0, slot.windows.length - 1);
    if (n === slot.focused || !slot.windows.length) return false;
    slot.focused = n;
    return true;
}

// The focused window swaps places with its neighbour in the stack.
function zoneMoveRow(zone, delta) {
    var slot = zone.slots[zone.focusedSlot];
    if (!slot) return false;
    var a = slot.focused, b = a + delta;
    if (b < 0 || b >= slot.windows.length) return false;
    var t = slot.windows[a]; slot.windows[a] = slot.windows[b]; slot.windows[b] = t;
    slot.focused = b;
    return true;
}

// Moves the focused window to the bottom of another slot's stack.
function zoneMoveToSlot(zone, to) {
    var from = zone.slots[zone.focusedSlot];
    if (!from || !from.windows.length || to < 0 || to >= zone.slots.length || to === zone.focusedSlot) return false;
    var w = from.windows[from.focused];
    zoneRemove(zone, w);
    zoneAdd(zone, w, to);
    return true;
}

// Meta+arrow into a slot: a slot holding ONE window swaps places with the focused window (the
// other one takes its row); an empty slot just receives it; a slot already holding a stack gets
// it added to the stack.
function zoneSnapTo(zone, to) {
    var from = zone.slots[zone.focusedSlot], tgt = zone.slots[to];
    if (!from || !from.windows.length || !tgt || to === zone.focusedSlot) return false;
    if (tgt.windows.length === 1) {
        var i = from.focused, w = from.windows[i];
        from.windows[i] = tgt.windows[0];
        tgt.windows[0] = w;
        tgt.focused = 0;
        zone.focusedSlot = to;
        return true;
    }
    return zoneMoveToSlot(zone, to);
}

// Nearest slot in a direction ("left"|"right"|"up"|"down"), by the slots' centres; a slot must
// overlap the origin along the other axis. nonEmpty: skip slots without windows.
function zoneNeighbour(zone, from, dir, nonEmpty) {
    var a = zone.slots[from].rect, ax = a.x + a.w / 2, ay = a.y + a.h / 2, best = -1, bestD = 1e9;
    for (var j = 0; j < zone.slots.length; j++) {
        if (j === from || (nonEmpty && !zone.slots[j].windows.length)) continue;
        var b = zone.slots[j].rect, bx = b.x + b.w / 2, by = b.y + b.h / 2, along, across;
        if (dir === "left" || dir === "right") {
            if (b.y >= a.y + a.h - 1e-6 || b.y + b.h <= a.y + 1e-6) continue;
            along = dir === "left" ? ax - bx : bx - ax; across = Math.abs(by - ay);
        } else {
            if (b.x >= a.x + a.w - 1e-6 || b.x + b.w <= a.x + 1e-6) continue;
            along = dir === "up" ? ay - by : by - ay; across = Math.abs(bx - ax);
        }
        if (along <= 1e-6) continue;
        var d = along + across * 0.5;
        if (d < bestD) { bestD = d; best = j; }
    }
    return best;
}

// The slot a window arriving while moving in `dir` should land in: the one nearest the edge it
// enters from.
function zoneEdgeSlot(zone, dir) {
    var best = 0, bestV = null;
    for (var j = 0; j < zone.slots.length; j++) {
        var r = zone.slots[j].rect, v;
        if (dir === "left") v = -(r.x + r.w);            // moving left: arrives at the right edge
        else if (dir === "right") v = r.x;
        else if (dir === "up") v = -(r.y + r.h);
        else v = r.y;
        if (bestV === null || v < bestV - 1e-9) { bestV = v; best = j; }
    }
    return best;
}

// Which slot a new window goes to. smart: a slot already holding a window of its app (the
// focused slot wins a tie), else the largest empty slot, else the focused slot. focused: always
// the focused slot.
function zoneSlotFor(zone, w, policy) {
    if (policy === "focused") return zone.focusedSlot;
    var app = String(w.resourceClass || ""), j, found = -1;
    for (j = 0; j < zone.slots.length && found < 0; j++) {
        var k = (zone.focusedSlot + j) % zone.slots.length;
        for (var i = 0; i < zone.slots[k].windows.length; i++)
            if (String(zone.slots[k].windows[i].resourceClass || "") === app) { found = k; break; }
    }
    if (found >= 0) return found;
    var bestA = -1;
    for (j = 0; j < zone.slots.length; j++) {
        if (zone.slots[j].windows.length) continue;
        var a = zone.slots[j].rect.w * zone.slots[j].rect.h;
        if (a > bestA + 1e-9) { bestA = a; found = j; }
    }
    return found >= 0 ? found : zone.focusedSlot;
}

function zoneSlotAt(zone, area, px, py) {
    var fx = (px - area.x) / area.width, fy = (py - area.y) / area.height, best = 0, bestD = 1e9;
    for (var j = 0; j < zone.slots.length; j++) {
        var r = zone.slots[j].rect;
        var dx = fx < r.x ? r.x - fx : (fx > r.x + r.w ? fx - r.x - r.w : 0);
        var dy = fy < r.y ? r.y - fy : (fy > r.y + r.h ? fy - r.y - r.h : 0);
        var d = dx * dx + dy * dy;
        if (d < bestD - 1e-12) { bestD = d; best = j; }
    }
    return best;
}

// Pure: where every window goes. Edges on the area's border keep `gap`, edges shared with a
// neighbouring slot keep half of it, so adjacent slots are `gap` apart.
function zoneLayout(zone, area, c) {
    var out = [], half = c.gap / 2;
    for (var s = 0; s < zone.slots.length; s++) {
        var slot = zone.slots[s], r = slot.rect, n = slot.windows.length;
        if (!n) continue;
        var L = Math.round(area.x + r.x * area.width + (r.x <= 0.001 ? c.gap : half));
        var R = Math.round(area.x + (r.x + r.w) * area.width - (r.x + r.w >= 0.999 ? c.gap : half));
        var T = Math.round(area.y + r.y * area.height + (r.y <= 0.001 ? c.gap : half));
        var B = Math.round(area.y + (r.y + r.h) * area.height - (r.y + r.h >= 0.999 ? c.gap : half));
        var total = (B - T) - c.gap * (n - 1), h = Math.floor(total / n);
        for (var i = 0; i < n; i++)
            out.push({ window: slot.windows[i], column: s, row: i, visible: true,
                       rect: { x: L, y: T + i * (h + c.gap), width: R - L, height: i === n - 1 ? total - h * (n - 1) : h } });
    }
    return out;
}

// Leaf tiles of KWin's tile tree as fractions of the root's area, in layout order.
function leafRects(root) {
    var ra = root.absoluteGeometry, out = [];
    (function walk(t) {
        var kids = t.tiles;
        if (!kids || !kids.length) {
            var a = t.absoluteGeometry;
            var q = function (v) { return Math.round(v * 10000) / 10000; };
            out.push({ x: q((a.x - ra.x) / ra.width), y: q((a.y - ra.y) / ra.height), w: q(a.width / ra.width), h: q(a.height / ra.height) });
            return;
        }
        for (var i = 0; i < kids.length; i++) walk(kids[i]);
    })(root);
    var horizontal = root.layoutDirection === undefined || root.layoutDirection === 1;
    out.sort(function (p, q2) { return horizontal ? (p.x - q2.x) || (p.y - q2.y) : (p.y - q2.y) || (p.x - q2.x); });
    return out;
}

// ---------------------------------------------------------------- KWin glue
var KWIN_ENV = typeof workspace !== "undefined" && typeof workspace.windowList === "function";

var state = {
    strips: {},        // key "output|desktopId" -> strip (+ outputName, desktopId)
    zones: {},         // key "Z:output|desktopId" -> zone (fixed regions), for outputs in regions mode
    modeFlip: {},      // output name -> "strip" | "regions": toggle-mode overrides cfg.regionOutputs
    overlays: {},      // window id -> {w, host}: windows sitting over a tiled window's cell (not in any container)
    splits: {},        // output name -> [baseKey]: tiles split top / bottom (persisted by the bar)
    regionsSig: "",    // signature of the tile layouts last seen, to notice Meta+T edits
    byWin: {},         // window id -> strip or zone key
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
function resolveOutputs(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var n = list[i];
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

function tilingOutputNames() { return resolveOutputs(cfg.outputs); }

function tilingOutput(name) { return tilingOutputNames().indexOf(name) >= 0; }

// "regions" (fixed slots from KWin's tile layout) or "strip" (scrolling columns), per output.
function outputMode(name) {
    if (state.modeFlip[name]) return state.modeFlip[name];
    return resolveOutputs(cfg.regionOutputs).indexOf(name) >= 0 ? "regions" : "strip";
}

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

function zoneKey(outName, deskId) { return "Z:" + outName + "|" + deskId; }

// The slots of KWin's tile layout for (output, desktop), as fractions of its area.
function readRegions(out, desk) {
    var rects = [];
    try {
        var root = workspace.rootTile(out, desk);
        if (root) rects = leafRects(root);
    } catch (e) { log("could not read the tile layout of " + out.name + ": " + e); }
    return rects.length ? rects : [{ x: 0, y: 0, w: 1, h: 1 }];
}

function getZone(outName, deskId, create) {
    var key = zoneKey(outName, deskId), z = state.zones[key];
    if (!z && create) {
        var out = outputByName(outName), desk = desktopById(deskId);
        if (!out || !desk) return null;
        z = makeZone(readRegions(out, desk), state.splits[outName] || []);
        z.key = key; z.outputName = outName; z.desktopId = deskId;
        state.zones[key] = z;
    }
    return z || null;
}

// Meta+T edits: when the layout changed, re-seat every window. Returns true if it did.
function refreshRegions(zone) {
    var out = outputByName(zone.outputName), desk = desktopById(zone.desktopId);
    if (!out || !desk) return false;
    var base = readRegions(out, desk), rects = zoneDerive(base, state.splits[zone.outputName] || []);
    if (JSON.stringify(rects) === zone.sig) return false;
    zone.base = base;
    zoneReseat(zone, rects);
    return true;
}

function wantedSig(z) {
    var out = outputByName(z.outputName), desk = desktopById(z.desktopId);
    return out && desk ? JSON.stringify(zoneDerive(readRegions(out, desk), state.splits[z.outputName] || [])) : z.sig;
}
function allContainers() {
    var out = [], k;
    for (k in state.strips) out.push(state.strips[k]);
    for (k in state.zones) out.push(state.zones[k]);
    return out;
}

function containerByKey(key) {
    if (key === undefined || key === null) return null;
    return (String(key).indexOf("Z:") === 0 ? state.zones : state.strips)[key] || null;
}

function contOf(w) { return containerByKey(state.byWin[wid(w)]); }

function windowsOf(c) {
    if (c.kind === "zone") return zoneWindows(c);
    var wins = [];
    for (var i = 0; i < c.columns.length; i++)
        for (var r = 0; r < c.columns[i].windows.length; r++) wins.push(c.columns[i].windows[r]);
    return wins;
}

function containerFocused(c) { return c.kind === "zone" ? zoneFocusedWindow(c) : stripFocusedWindow(c); }

function containerFocusWindow(c, w) { return c.kind === "zone" ? zoneFocusWindow(c, w) : stripFocusWindow(c, w); }

function deleteContainer(c) { delete (c.kind === "zone" ? state.zones : state.strips)[c.key]; }

function workArea(strip) {
    var out = outputByName(strip.outputName), desk = desktopById(strip.desktopId);
    if (!out || !desk) return null;
    var a = workspace.clientArea(KWin.MaximizeArea, out, desk), st = cfg.struts;
    var g = out.geometry, portrait = g.height > g.width, vertical = cfg.portraitVertical && portrait;
    if (strip.kind !== "zone" && vertical !== strip.vertical) { strip.vertical = vertical; strip.scrollX = 0; }
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
    var id = wid(w), c = contOf(w);
    if (state.byWin[id] === undefined) return null;
    if (c) { if (c.kind === "zone") zoneRemove(c, w); else stripRemove(c, w); }
    delete state.byWin[id];
    releaseWindow(w);
    return c;
}

// Adds w to a fixed-region zone (slot: where, else by the new-window policy).
function tileZone(w, out, slot) {
    var zone = getZone(out, w.desktops[0].id, true);
    if (!zone) return null;
    if (zoneFind(zone, w)) return zone;
    zoneAdd(zone, w, slot !== undefined ? slot : zoneSlotFor(zone, w, cfg.regionsNewWindow));
    state.byWin[wid(w)] = zone.key;
    return zone;
}
// Adds w to the strip of (output, its desktop). Returns the strip or null.
function tile(w, outName, slot) {
    if (state.released || !state.started || state.floating[wid(w)] || !isTileable(w)) return null;
    var out = outName || w.output.name;
    if (!tilingOutput(out) || !outputByName(out)) return null;
    if (outputMode(out) === "regions") return tileZone(w, out, slot);
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
    var before = workspace.activeWindow, target = focusTarget || null, infos = {}, orphans = [];
    try {
        var cur = workspace.currentDesktop, conts = allContainers();
        for (var ci = 0; ci < conts.length; ci++) {
            var strip = conts[ci];
            if (strip.desktopId !== cur.id) continue;
            var area = workArea(strip);
            if (!area) continue;
            if (strip.kind === "zone") refreshRegions(strip);
            // A strip whose windows left (moved to another monitor, minimized by the user) may be
            // scrolled past its end: keep the focused column in view before laying out.
            else if (strip.columns.length) {
                reveal(strip, strip.focusedColumn);
                // Everything fits: nothing may stay scrolled (and minimized) from when there was more.
                var xs2 = columnXs(strip, area, cfg), end = xs2[xs2.length - 1];
                var fits = end.x + end.w + cfg.gap <= mainLen(strip, area) + 1;
                if (!fits) strip.align = null;
                else if (strip.align === "right") strip.scrollX = end.x + end.w + cfg.gap - mainLen(strip, area);   // flush with the far edge
                else if (cfg.center !== "always" && !(cfg.centerSingle && strip.columns.length === 1)) strip.scrollX = 0;
            }
            var entries = strip.kind === "zone" ? zoneLayout(strip, area, cfg) : computeLayout(strip, area, cfg);
            strip.lastLayout = entries;
            for (var ei = 0; ei < entries.length; ei++) infos[wid(entries[ei].window)] = { rect: entries[ei].rect, visible: entries[ei].visible };
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
                target = entriesVisible(entries, before) ? before : containerFocused(strip);
        }
        for (var oid in state.overlays) {
            var ov = state.overlays[oid], ow = ov.w;
            if (ow.deleted) { delete state.overlays[oid]; continue; }
            var hostKey = ov.host.deleted ? undefined : state.byWin[wid(ov.host)];
            if (hostKey === undefined) { orphans.push(ow); continue; }       // its host left the grid
            var hostCont = containerByKey(hostKey), info = infos[wid(ov.host)];
            if (!hostCont || hostCont.desktopId !== cur.id || !info || ow.fullScreen || state.interactive[oid]) continue;
            if (info.visible) {
                if (state.scriptMin[oid]) { delete state.scriptMin[oid]; setMinimized(ow, false); }
                if (!ow.minimized) writeGeometry(ow, info.rect);
            } else if (!ow.minimized) {
                setMinimized(ow, true); state.scriptMin[oid] = true;
            }
        }
    } finally {
        state.applying = false;
    }
    for (var oi = 0; oi < orphans.length; oi++) {
        delete state.overlays[wid(orphans[oi])];
        if (!tile(orphans[oi])) continue;
        state.pendingLayout = true;
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

var regionsTimer = null;                         // notices Meta+T edits to the tile layouts
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
    var strip = containerByKey(refocusKey);
    refocusKey = null;
    if (!strip || state.released) return;
    var aw = workspace.activeWindow, target = containerFocused(strip);
    if (target && !target.deleted && !(aw && contOf(aw) === strip)) {
        if (strip.kind !== "zone") reveal(strip, strip.focusedColumn);
        layoutAll(target);
    }
}
function stripOf(w) { return contOf(w); }   // a strip or a zone: callers that need a strip check .kind
// Window moved desktop/output (or became tileable/untileable): redo its membership.
function retile(w) {
    if (state.released) return;
    delete state.overlays[wid(w)];   // moved / restored on its own: it is a normal tiled window from now on
    var old = contOf(w);
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
    var stale = allContainers().filter(function (c) { return !outputByName(c.outputName) || !tilingOutput(c.outputName); });
    for (var i = 0; i < stale.length; i++) {
        var wins = windowsOf(stale[i]);
        for (var j = 0; j < wins.length; j++) {
            untile(wins[j]);
            if (live.length && !wins[j].deleted) tile(wins[j], live[0]);
        }
        deleteContainer(stale[i]);
    }
    if (stale.length) log("output change: moved " + stale.length + " strip(s) to " + (live.length ? live[0] : "nowhere (floating)"));
}

// An output's mode changed (settings, or toggle-mode): its windows move to the other kind of
// container, in their current order, and are placed by that mode's rules.
function migrateModes() {
    if (!state.started || state.released) return 0;
    var wrong = allContainers().filter(function (c) { return (outputMode(c.outputName) === "regions") !== (c.kind === "zone"); });
    var all = [];
    for (var i = 0; i < wrong.length; i++) {
        var wins = windowsOf(wrong[i]);
        for (var j = 0; j < wins.length; j++) { untile(wins[j]); all.push(wins[j]); }
        deleteContainer(wrong[i]);
    }
    for (var k = 0; k < all.length; k++) if (!all[k].deleted) tile(all[k]);
    return wrong.length;
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
        var strip = stripOf(w);
        if (strip && strip.kind === "zone") { forgetRects(strip); layoutAll(w); return; }   // slots do not maximize
        var at = strip ? stripFind(strip, w) : null;
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
        if (strip && strip.kind !== "zone") {
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
        if (state.overlays[i] && rec) {
            // dragged out from over its host: it floats where it was dropped; a resize snaps back
            if (!rec.resizing) { delete state.overlays[i]; state.floating[i] = true; }
            scheduleLayout();
            return;
        }
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
    cp.focusedColumn = strip.focusedColumn; cp.scrollX = strip.scrollX; cp.vertical = strip.vertical; cp.align = strip.align;
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
    if (old && old.kind !== "zone") reveal(old, old.focusedColumn);
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
    directionalMove(w, strip, dir);
}

// Is the strip's far edge (dir > 0: end, dir < 0: start) flush with the working area?
function stripFlush(strip, area, d) {
    var xs = columnXs(strip, area, cfg);
    if (!xs.length) return true;
    if (d > 0) { var last = xs[xs.length - 1]; return last.x + last.w + cfg.gap - strip.scrollX >= mainLen(strip, area) - 1; }
    return xs[0].x - cfg.gap - strip.scrollX <= 1;
}

// What Meta+arrow does to a tiled window (also what the quick-tile fallback does):
//  - a column / window / slot that can move that way moves;
//  - at the end of a strip the last column first SNAPS to that edge of the monitor (a full-width
//    one is cut to the default width, the strip is packed flush with the edge) like KDE's
//    "tile to the right half";
//  - snapped already, it hops to the next monitor that way and arrives at the edge it came from;
//  - Up / Down on a landscape strip with nothing to reorder: maximize / restore the column.
function directionalMove(w, c, dir) {
    var d = dir === "left" || dir === "up" ? -1 : 1, area = workArea(c);
    containerFocusWindow(c, w);
    var prev = c.kind === "zone" ? 0 : c.focusedColumn, moved = false, snapped = false;
    if (c.kind === "zone") {
        // Meta+arrow only moves between regions (swap with a single occupant): no stack reordering, no hopping monitors
        var to = zoneNeighbour(c, c.focusedSlot, dir, false);
        moved = to >= 0 ? zoneSnapTo(c, to) : false;
        forgetRects(c);
        layoutAll(w);
        return;
    } else if (!area) {
        moved = false;
    } else if (!dirIsMain(c, dir)) {
        moved = stripMoveRow(c, d);
        if (!moved && !c.vertical) {                   // landscape Up / Down
            var col = c.columns[c.focusedColumn];
            if (dir === "up" && col.frac < 0.99) moved = stripToggleMaximize(c);
            else if (dir === "down" && col.prevFrac !== null) moved = stripToggleMaximize(c);
        }
    } else {
        moved = stripMoveColumn(c, d);
        if (!moved) {
            var idx = d > 0 ? c.columns.length - 1 : 0, col2 = c.columns[idx];
            var wide = col2.frac > cfg.defaultWidth + 0.01, flushed = stripFlush(c, area, d);
            if (wide || !flushed) {
                if (wide) { col2.frac = cfg.defaultWidth; col2.prevFrac = null; }
                c.align = d > 0 ? "right" : null;
                if (d > 0) c.scrollX = (function () { var xs = columnXs(c, area, cfg), e = xs[xs.length - 1]; return e.x + e.w + cfg.gap - mainLen(c, area); })();
                else c.scrollX = 0;
                moved = true; snapped = true;
            }
        }
    }
    if (moved) {
        if (c.kind !== "zone" && !snapped) reveal(c, prev);
        forgetRects(c);
        layoutAll(w);
        return;
    }
    var hop = neighbourOutput(c.outputName, dir);
    if (!hop || !w.desktops || w.desktops.length !== 1) { forgetRects(c); layoutAll(w); return; }
    hopTo(w, c, hop, dir);
}

// Sends `w` to the next tiling monitor in `dir`; it arrives at the edge it came in from.
function hopTo(w, from, hop, dir) {
    var d = dir === "left" || dir === "up" ? -1 : 1, desk = w.desktops[0].id, frac = cfg.defaultWidth;
    if (from.kind !== "zone") {
        var at = stripFind(from, w), solo = at && from.columns[at.c].windows.length === 1;
        if (solo) frac = from.columns[at.c].frac;
    }
    if (outputMode(hop) === "regions") {
        var zone = getZone(hop, desk, true);
        if (!zone) return;
        var old = untile(w);
        if (old && old.kind !== "zone") reveal(old, old.focusedColumn);
        tileZone(w, hop, zoneEdgeSlot(zone, dir));
        forgetRects(zone);
        layoutAll(w);
        return;
    }
    var target = getStrip(hop, desk, true);
    if (!target.columns.length) target.align = d < 0 ? "right" : null;   // a lone arrival sits at the edge it came in from
    moveToStrip(w, target, d < 0 ? target.columns.length : 0, frac);
}

// One step of a directional move inside a zone: left/right go to the neighbouring slot, up/down
// reorder the stack and, at its end, go to the slot above/below.
function zoneMoveDir(zone, dir) {
    if (dir === "up" || dir === "down") {
        if (zoneMoveRow(zone, dir === "up" ? -1 : 1)) return true;
    }
    var to = zoneNeighbour(zone, zone.focusedSlot, dir, false);
    return to >= 0 ? zoneMoveToSlot(zone, to) : false;
}

// One step of a directional focus inside a zone.
function zoneFocusDir(zone, dir) {
    if ((dir === "up" || dir === "down") && zoneFocusRow(zone, dir === "up" ? -1 : 1)) return true;
    var to = zoneNeighbour(zone, zone.focusedSlot, dir, true);
    if (to < 0) return false;
    zone.focusedSlot = to;
    return true;
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

function forgetRects(c) {
    var wins = windowsOf(c);
    for (var i = 0; i < wins.length; i++) delete state.lastRect[wid(wins[i])];
}
function finishResize(w, strip, rec, cur) {
    if (strip.kind === "zone") { forgetRects(strip); layoutAll(w); return; }   // slots are fixed: edit them with Meta+T
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
    var out = w.output, isZone = strip.kind === "zone";
    var tileable = out && tilingOutput(out.name) && w.desktops && w.desktops.length === 1;
    if (rec.body || (travelled >= 6 && !tileable)) {
        state.floating[i] = true;
        untile(w);
        if (!isZone) reveal(strip, strip.focusedColumn);
        layoutAll(w);
        return;
    }
    if (travelled < 6 || !tileable) { forgetRects(strip); layoutAll(w); return; }
    var frac = cfg.defaultWidth;
    if (!isZone) {
        var at = stripFind(strip, w);
        if (at && strip.columns[at.c].windows.length === 1) frac = strip.columns[at.c].frac;
    }
    var desk = w.desktops[0].id;
    if (outputMode(out.name) === "regions") {
        // dropped on a monitor with fixed regions: into the slot under the window's centre
        var zone = getZone(out.name, desk, true), zarea = zone ? workArea(zone) : null;
        if (!zarea) { forgetRects(strip); layoutAll(w); return; }
        var slot = zoneSlotAt(zone, zarea, cur.x + cur.width / 2, cur.y + cur.height / 2);
        var old = untile(w);
        if (old && old.kind !== "zone") reveal(old, old.focusedColumn);
        tileZone(w, out.name, slot);
        forgetRects(zone);
        layoutAll(w);
        return;
    }
    var target = getStrip(out.name, desk, true), area = workArea(target);
    if (!area) { forgetRects(strip); layoutAll(w); return; }
    var old2 = untile(w);
    if (old2 && old2.kind !== "zone") reveal(old2, old2.focusedColumn);
    var centre = target.vertical ? cur.y + cur.height / 2 - area.y : cur.x + cur.width / 2 - area.x;
    var at2 = stripInsertColumn(target, w, dropIndex(target, area, cfg, centre), frac);
    state.byWin[i] = target.key;
    forgetRects(target);
    reveal(target, at2);
    layoutAll(w);
}
// A window that is NOT in any container but shares a tiled window's cell: it is written the
// host's rectangle on every layout, is shown/hidden with the host, and nothing else about the
// layout (columns, slots, scroll) changes. KWin puts the newest window on top; activating the
// host raises it again.
//
// Which window a new one opens over: a window of the same app that is on screen, else the focused
// tiled window of that monitor, else any window on screen. Returns null when there is none (an
// empty monitor, a floating window, a dialog): the window then tiles normally.
function overlayTarget(w) {
    if (!cfg.newWindowOverlay || state.released || !state.started || state.floating[wid(w)] || !isTileable(w)) return null;
    var out = w.output.name;
    if (!tilingOutput(out) || !outputByName(out)) return null;
    var desk = w.desktops[0].id;
    var c = outputMode(out) === "regions" ? getZone(out, desk, false) : getStrip(out, desk, false);
    if (!c || c.desktopId !== workspace.currentDesktop.id) return null;
    var shown = {};
    (c.lastLayout || []).forEach(function (e) { if (e.visible && !e.window.minimized && !e.window.deleted) shown[wid(e.window)] = e.window; });
    var cands = windowsOf(c).filter(function (x) { return shown[wid(x)] && x !== w; });
    if (!cands.length) return null;
    var focus = containerFocused(c), app = String(w.resourceClass || "");
    var same = cands.filter(function (x) { return String(x.resourceClass || "") === app; });
    if (same.length) return same.indexOf(focus) >= 0 ? focus : same[0];
    return cands.indexOf(focus) >= 0 ? focus : cands[0];
}

function overlaysOf(host) {
    var out = [];
    for (var id in state.overlays) if (state.overlays[id].host === host) out.push(state.overlays[id]);
    return out;
}

// The overlay becomes a real member of the grid, next to / under its host.
function unoverlay(ow) {
    var id = wid(ow), o = state.overlays[id];
    if (!o) return false;
    delete state.overlays[id];
    var c = contOf(o.host);
    if (!c) { tile(ow); return true; }
    if (c.kind === "zone") {
        var at = zoneFind(c, o.host);
        zoneAdd(c, ow, at ? at.s : c.focusedSlot);
    } else {
        var at2 = stripFind(c, o.host);
        stripInsertColumn(c, ow, at2 ? at2.c + 1 : c.columns.length, cfg.defaultWidth);
        reveal(c, c.focusedColumn);
    }
    state.byWin[id] = c.key;
    forgetRects(c);
    layoutAll(ow);
    return true;
}

// `old` leaves its cell and `nw` takes it.
function replaceInContainer(c, old, nw) {
    if (c.kind === "zone") {
        var z = zoneFind(c, old);
        if (z) c.slots[z.s].windows[z.i] = nw;
    } else {
        var r = stripFind(c, old);
        if (r) { c.columns[r.c].windows[r.r] = nw; if (c.weights[wid(old)] !== undefined) { c.weights[wid(nw)] = c.weights[wid(old)]; delete c.weights[wid(old)]; } }
    }
    state.byWin[wid(nw)] = c.key;
    delete state.byWin[wid(old)];
}

function onWindowAdded(w) {
    wireWindow(w);
    var host = overlayTarget(w);
    if (host) {
        state.overlays[wid(w)] = { w: w, host: host };
        layoutAll(w);
        return;
    }
    var s = tile(w);
    if (s) layoutAll(w);
    else scheduleLayout();
}

function onWindowRemoved(w) {
    var id = wid(w), strip = stripOf(w), wasActive = state.lastActive === id;
    var asOverlay = state.overlays[id] || null;
    delete state.overlays[id];
    var heirs = overlaysOf(w), heir = null;
    if (strip && heirs.length) {
        // the host closed with windows over it: the newest one takes its cell
        heir = heirs[heirs.length - 1].w;
        delete state.overlays[wid(heir)];
        replaceInContainer(strip, w, heir);
        for (var hi = 0; hi < heirs.length - 1; hi++) heirs[hi].host = heir;
        strip = null;
    }
    if (strip) {
        if (strip.kind === "zone") zoneRemove(strip, w); else stripRemove(strip, w);
        delete state.byWin[id];
    }
    delete state.scriptMin[id]; delete state.lastRect[id]; delete state.expectMin[id];
    delete state.interactive[id]; delete state.wired[id]; delete state.floating[id];
    delete state.geomDirty[id]; delete state.fixes[id];
    if (state.dragId === id) state.dragId = null;
    if (heir) {
        forgetRects(contOf(heir));
        layoutAll(wasActive ? heir : null);
    } else if (asOverlay) {
        // an overlay closed: focus goes back to what it was over
        var hc = contOf(asOverlay.host);
        layoutAll(wasActive ? asOverlay.host : null);
        if (wasActive && hc) scheduleRefocus(hc.key);
    } else if (strip) {
        if (strip.kind !== "zone") reveal(strip, strip.focusedColumn);
        layoutAll(wasActive ? containerFocused(strip) : null);
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
    if (strip.kind === "zone") {
        if (zoneFocusWindow(strip, w)) layoutAll(w);
        return;
    }
    var prev = strip.focusedColumn;
    if (!stripFocusWindow(strip, w)) return;
    reveal(strip, prev);
    layoutAll(w);
}
// ---------------------------------------------------------------- Commands
function currentContainer() {
    var aw = workspace.activeWindow;
    if (aw && state.overlays[wid(aw)]) aw = state.overlays[wid(aw)].host;   // focus keys move on from what it sits over
    var s = aw ? stripOf(aw) : null;
    if (s) { containerFocusWindow(s, aw); return s; }   // commands act on what is really focused
    var out = workspace.activeScreen, name = null;
    if (out && tilingOutput(out.name)) name = out.name;
    else { var names = tilingOutputNames(); if (names.length) name = names[0]; }
    if (!name) return null;
    var desk = workspace.currentDesktop.id;
    return outputMode(name) === "regions" ? getZone(name, desk, true) : getStrip(name, desk, true);
}
// Mutate the model with fn(strip), then reveal the focused column and apply.
// Mutate the model with sfn(strip) (a strip) or zfn(zone) (a zone; commands that mean nothing
// there leave it out), then apply. A strip also scrolls its focused column into view.
function withCont(sfn, zfn, keepScroll) {
    var c = currentContainer();
    if (!c) return { ok: false, error: "no strip" };
    if (c.kind === "zone") {
        if (!zfn || !zfn(c)) return { ok: true, changed: false };
        layoutAll(zoneFocusedWindow(c));
        return { ok: true, changed: true };
    }
    var prev = c.focusedColumn;
    if (!sfn(c)) return { ok: true, changed: false };
    if (!keepScroll) reveal(c, prev);
    layoutAll(stripFocusedWindow(c));
    return { ok: true, changed: true };
}

function withStrip(fn, keepScroll) { return withCont(fn, null, keepScroll); }
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
    state.strips = {}; state.zones = {}; state.byWin = {}; state.overlays = {};
    sendReport(true);
    return n;
}

// Directional commands follow the screen: in a vertical (portrait) strip up/down run along the
// strip and left/right move between the windows side by side in one row.
function dirIsMain(strip, dir) {
    return strip.vertical ? (dir === "up" || dir === "down") : (dir === "left" || dir === "right");
}

function focusDir(dir) {
    return withCont(function (s) {
        var d = dir === "left" || dir === "up" ? -1 : 1;
        return dirIsMain(s, dir) ? stripFocusColumn(s, d) : stripFocusRow(s, d);
    }, function (z) { return zoneFocusDir(z, dir); });
}
function moveDir(dir) {
    return withCont(function (s) {
        var d = dir === "left" || dir === "up" ? -1 : 1;
        return dirIsMain(s, dir) ? stripMoveColumn(s, d) : stripMoveRow(s, d);
    }, function (z) { return zoneMoveDir(z, dir); });
}
// Meta+arrow while the tiler owns the keys: a tiled window follows directionalMove; any other
// window (floating, or on a monitor that does not tile) gets KDE's own quick tile, invoked by name.
var QUICK_TILE = { left: "Window Quick Tile Left", right: "Window Quick Tile Right",
                   up: "Window Quick Tile Top", down: "Window Quick Tile Bottom" };

function snapDir(dir) {
    var w = workspace.activeWindow, c = w ? stripOf(w) : null;
    if (w && w.fullScreen) return { ok: true, changed: false };
    if (!c) {
        callDBus("org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component", "invokeShortcut", QUICK_TILE[dir]);
        return { ok: true, passed: true };
    }
    if (c.kind !== "zone" && !cfg.arrowKeysScrollStrips) return { ok: true, changed: false };   // scrolling monitors: leave it
    directionalMove(w, c, dir);
    return { ok: true };
}

var COMMANDS = {
    "snap-left": function () { return snapDir("left"); },
    "snap-right": function () { return snapDir("right"); },
    "snap-up": function () { return snapDir("up"); },
    "snap-down": function () { return snapDir("down"); },
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
        if (state.overlays[wid(w)]) {                       // over a tiled window: it just floats there
            delete state.overlays[wid(w)];
            state.floating[wid(w)] = true;
            layoutAll(w);
            return { ok: true, floating: true };
        }
        var strip = stripOf(w);
        if (strip) {
            state.floating[wid(w)] = true;
            untile(w);
            if (strip.kind !== "zone") reveal(strip, strip.focusedColumn);
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
        return withCont(function (s) {
            var n = clamp(Number(arg) | 0, 0, s.columns.length - 1);
            if (!s.columns.length || n === s.focusedColumn) return false;
            s.focusedColumn = n;
            return true;
        }, function (z) {
            // a slot: focus its window; an empty slot becomes where the next new window goes
            var n = clamp(Number(arg) | 0, 0, z.slots.length - 1);
            if (n === z.focusedSlot) return false;
            z.focusedSlot = n;
            return z.slots[n].windows.length > 0;
        });
    },
    // regions mode: the focused window goes to slot N (1-based), bottom of its stack
    "send-to-slot": function (arg) {
        return withCont(function () { return false; }, function (z) {
            return zoneMoveToSlot(z, (Number(arg) | 0) - 1);
        });
    },
    // regions mode: cut the focused tile into a top and a bottom half, or merge it back
    "split-region": function () {
        var c = currentContainer();
        if (!c || c.kind !== "zone") return { ok: false, error: "not a regions monitor" };
        var slot = c.slots[c.focusedSlot];
        if (!slot) return { ok: false, error: "no region" };
        var list = (state.splits[c.outputName] || []).slice(), at = list.indexOf(slot.rect.key);
        if (at >= 0) list.splice(at, 1); else list.push(slot.rect.key);
        if (list.length) state.splits[c.outputName] = list; else delete state.splits[c.outputName];
        layoutAll(zoneFocusedWindow(c));
        return { ok: true, split: at < 0 };
    },
    // flip an output between scrolling columns and fixed regions (arg: output name, else the focused one)
    "toggle-mode": function (arg) {
        var name = arg ? String(arg) : null;
        if (!name) {
            var c = currentContainer();
            name = c ? c.outputName : null;
        }
        if (!name || !outputByName(name) || !tilingOutput(name)) return { ok: false, error: "no tiling output" };
        state.modeFlip[name] = outputMode(name) === "regions" ? "strip" : "regions";
        migrateModes();
        layoutAll(null);
        return { ok: true, mode: state.modeFlip[name] };
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

// Commands that move or resize the focused window make an overlay a real member of the grid first.
var PROMOTES = { "move-column-left": 1, "move-column-right": 1, "move-window-up": 1, "move-window-down": 1,
                 "consume-left": 1, "consume-right": 1, "expel": 1, "consume-or-expel-left": 1,
                 "consume-or-expel-right": 1, "cycle-width": 1, "maximize-column": 1, "send-to-slot": 1,
                 "snap-left": 1, "snap-right": 1, "snap-up": 1, "snap-down": 1 };

function runCommand(name, arg) {
    var fn = COMMANDS[name];
    if (!fn) return { ok: false, error: "unknown command" };
    if (!state.started && !IDLE_OK[name]) return { ok: false, error: "not configured yet" };
    try {
        var aw = workspace.activeWindow;
        if (PROMOTES[name] && aw && state.overlays[wid(aw)]) unoverlay(aw);
        return fn(arg) || { ok: true };
    }
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
    { text: "Toggle floating", key: "Meta+Alt+V", cmd: "float-toggle" },
    { text: "Split / merge the focused region (top and bottom)", key: "Ctrl+Meta+S", cmd: "split-region" },
    { text: "Snap left", key: "Meta+Left", cmd: "snap-left" },
    { text: "Snap right", key: "Meta+Right", cmd: "snap-right" },
    { text: "Snap up", key: "Meta+Up", cmd: "snap-up" },
    { text: "Snap down", key: "Meta+Down", cmd: "snap-down" },
    { text: "Switch this monitor between scrolling and fixed regions", key: "Meta+Alt+G", cmd: "toggle-mode" },
    { text: "Send window to region 1", key: "Meta+Alt+1", cmd: "send-to-slot", arg: 1 },
    { text: "Send window to region 2", key: "Meta+Alt+2", cmd: "send-to-slot", arg: 2 },
    { text: "Send window to region 3", key: "Meta+Alt+3", cmd: "send-to-slot", arg: 3 },
    { text: "Send window to region 4", key: "Meta+Alt+4", cmd: "send-to-slot", arg: 4 },
    { text: "Send window to region 5", key: "Meta+Alt+5", cmd: "send-to-slot", arg: 5 },
    { text: "Send window to region 6", key: "Meta+Alt+6", cmd: "send-to-slot", arg: 6 }
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

function sortObj(o) {
    var out = {}, ks = Object.keys(o).sort();
    for (var i = 0; i < ks.length; i++) out[ks[i]] = o[ks[i]].slice().sort();
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
    if (c.regionSplits && typeof c.regionSplits === "object" && !Array.isArray(c.regionSplits)) {
        var sp = {}, n = 0;
        for (var on in c.regionSplits) {
            var keys = strList(c.regionSplits[on], 16, 40);
            if (!keys || ++n > 8) continue;
            keys = keys.filter(function (k) { return /^-?[0-9.]+(,-?[0-9.]+){3}$/.test(k); });
            if (keys.length) sp[on] = keys.sort();
        }
        if (JSON.stringify(sortObj(sp)) !== JSON.stringify(sortObj(state.splits))) state.splits = sp;
    }
    if (typeof c.newWindowOverlay === "boolean") cfg.newWindowOverlay = c.newWindowOverlay;
    if (typeof c.arrowKeysScrollStrips === "boolean") cfg.arrowKeysScrollStrips = c.arrowKeysScrollStrips;
    var ro = strList(c.regionOutputs, 8, 64);
    if (ro) cfg.regionOutputs = ro;
    if (c.regionsNewWindow === "smart" || c.regionsNewWindow === "focused") cfg.regionsNewWindow = c.regionsNewWindow;
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
    migrateModes();
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
    rep.splits = {};
    for (var spo in state.splits) if (state.splits[spo].length) rep.splits[spo] = state.splits[spo].slice().sort();
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
            desktop: strip.desktopId, focusedColumn: strip.focusedColumn, vertical: strip.vertical === true, mode: "strip",
            scroll: Math.round(clamp(strip.scrollX / span, 0, 1) * 1000) / 1000, columns: cols
        };
    }
    for (var zk in state.zones) {
        var zone = state.zones[zk];
        if (zone.desktopId !== cur.id) continue;
        var zvis = {}, zlay = zone.lastLayout || [];
        for (var zi = 0; zi < zlay.length; zi++) zvis[wid(zlay[zi].window)] = zlay[zi].visible;
        var scols = [];
        for (var si = 0; si < zone.slots.length; si++) {
            var slot = zone.slots[si], zws = [];
            for (var wi = 0; wi < slot.windows.length; wi++) {
                var zw = slot.windows[wi];
                zws.push({ id: wid(zw), app: String(zw.resourceClass || "").slice(0, 64),
                           focused: si === zone.focusedSlot && wi === slot.focused });
            }
            scols.push({ width: Math.round(slot.rect.w * 1000) / 1000, visible: zws.length > 0, windows: zws });   // empty slots show dim
        }
        rep.outputs[zone.outputName] = { desktop: zone.desktopId, focusedColumn: zone.focusedSlot, vertical: false,
                                         mode: "regions", scroll: 0, columns: scols };
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

    regionsTimer = new QTimer();
    regionsTimer.singleShot = false;
    regionsTimer.interval = 1500;
    regionsTimer.timeout.connect(guard("regionsTimer", function () {
        if (state.released || !state.started || state.applying) return;
        for (var k in state.zones) {
            var z = state.zones[k], out = outputByName(z.outputName), desk = desktopById(z.desktopId);
            if (out && desk && wantedSig(z) !== z.sig) { layoutAll(null); return; }
        }
    }));
    regionsTimer.start();

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
    if (as) { containerFocusWindow(as, aw); if (as.kind !== "zone") reveal(as, as.focusedColumn); }

    if (cfg.shortcuts) {
        SHORTCUTS.forEach(function (sc) {
            registerShortcut(cfg.shortcutPrefix + sc.text, cfg.shortcutPrefix + sc.text, sc.key,
                             guard("shortcut " + sc.cmd, function () { runCommand(sc.cmd, sc.arg); }));
        });
    }
    layoutAll(null);
    sendReport(true);
    log("started: outputs=" + tilingOutputNames().join(",") + " tiled=" + Object.keys(state.byWin).length);
}

if (KWIN_ENV) init();
