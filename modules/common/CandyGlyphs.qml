pragma Singleton

import QtQuick
import Quickshell

/**
 * KWin port addition: burningb95's hand-picked icons in place of specific
 * Material Symbols. MaterialSymbol asks sourceFor(name) and, when it gets a
 * file back, draws that image at the same size instead of the font glyph.
 *
 * Two kinds of key:
 *  - a Material Symbols name, swapped everywhere it appears. Only names that
 *    mean one thing throughout iNiR are listed.
 *  - a "candy:<id>" name, set explicitly at a call site where the Material
 *    name is too generic to map globally (e.g. "schedule" is mostly a clock,
 *    but on the widget tab it means the timer; "dark_mode" is also the
 *    night marker in clocks, so only the dark-mode toggles opt in).
 *
 * The SVGs live in assets/candy (sources and licenses in its CREDITS.md).
 */
Singleton {
    id: root

    readonly property string dir: Quickshell.shellPath("assets/candy")

    readonly property var files: ({
        "clear-notifications": "clear-notifications.svg",
        "do-not-disturb": "do-not-disturb.svg",
        "dark-mode": "dark-mode.svg",
        "game-mode": "game-mode.svg",
        "calendar": "calendar.svg",
        "calculator": "calculator.svg",
        "search": "search.svg",
        "timer": "timer.svg",
        "todo": "todo.svg"
    })

    readonly property var materialMap: ({
        "delete_sweep": "clear-notifications",
        "do_not_disturb_on": "do-not-disturb",
        "notifications_paused": "do-not-disturb",
        "gamepad": "game-mode",
        "sports_esports": "game-mode",
        "calendar_month": "calendar",
        "calculate": "calculator",
        "search": "search",
        "hourglass_empty": "timer",
        "checklist": "todo"
    })

    function sourceFor(name: string): string {
        const n = String(name ?? "")
        const id = n.startsWith("candy:") ? n.slice(6) : (root.materialMap[n] ?? "")
        const file = root.files[id]
        return file ? `file://${root.dir}/${file}` : ""
    }
}
