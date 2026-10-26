pragma Singleton

import QtQuick
import Quickshell
import Quickshell.Io
import qs.modules.common
import qs.services

/**
 * KWin port: runs helpers/kwinir_bridge.py, the small D-Bus helper that gives
 * the bar what KWin can't hand Quickshell directly:
 *   - fullscreen: whether a fullscreen window is visible (game mode auto-detect),
 *     reported by a KWin script the helper loads at runtime;
 *   - capture: Spectacle's region selector is up (same script) — Overlay
 *     surfaces step beneath it;
 *   - file-transfer progress: it owns org.kde.JobViewServer and shows KIO jobs
 *     (Dolphin copies, downloads) as progress notifications
 *     (notifications.jobProgress, default on);
 *   - KWin state: focused output and overview, polled in-process (no gdbus spawns);
 *     KWinService uses these while `statePolled` and falls back to its own poll;
 *   - tiling (tiling.enable): the helper loads helpers/kwinir-tiling.js, this singleton sends it
 *     the options and commands over the helper's stdin and exposes its state report as `tiling`.
 * The helper is a child of this process: it starts and stops with the bar, and
 * is restarted if it dies. Only the bar process runs it — the settings window
 * loads services too, and a second helper would take the D-Bus names over.
 */
Singleton {
    id: root

    readonly property bool enabled: CompositorService.isKWin && Config.ready && !Config.isSettingsProcess
    readonly property bool jobProgress: Config.options?.notifications?.jobProgress ?? true
    property bool ready: false
    property bool fullscreen: false
    property bool capture: false
    property int activeJobs: 0
    property string activeOutput: ""
    property bool overview: false
    readonly property bool statePolled: root.ready && root.activeOutput !== ""
    // Emitted on every poll report (not just on change), so consumers re-assert state.
    signal outputPolled(string name)
    signal overviewPolled(bool open)

    // KWin port: scrolling tiling. `tiling` is the helper's last (validated) report:
    // {enabled, outputs: {<name>: {desktop, focusedColumn, scroll, vertical, mode, columns: [{width, visible,
    // windows: [{id, app, focused}]}]}}}. Toggling tiling.enable restarts the helper, which
    // releases every window the script minimized before it unloads the script.
    readonly property bool tilingEnabled: root.enabled && (Config.options?.tiling?.enable ?? true)
    property var tiling: ({ enabled: false, outputs: ({}) })
    readonly property var tilingConfig: {
        const t = Config.options?.tiling
        return {
            gap: t?.gap ?? 12,
            defaultWidth: t?.defaultWidth ?? 0.5,
            presetWidths: Array.from(t?.presetWidths ?? [0.3333, 0.5, 0.6667]),
            center: t?.center ?? "on-overflow",
            struts: ({ left: t?.struts?.left ?? 0, right: t?.struts?.right ?? 0,
                       top: t?.struts?.top ?? 0, bottom: t?.struts?.bottom ?? 0 }),
            regionOutputs: Array.from(t?.regionOutputs ?? []),
            regionSplits: root._parseSplits(t?.regionSplits),
            newWindowOverlay: t?.newWindowOverlay ?? true,
            arrowKeysScrollStrips: t?.arrowKeysScrollStrips ?? false,
            regionsNewWindow: t?.regionsNewWindow ?? "smart",
            portraitVertical: t?.portraitVertical ?? true,
            portraitDockStrip: t?.portraitDockStrip ?? 8,
            centerSingle: t?.centerSingle ?? false,
            expandSingle: t?.expandSingle ?? false,
            outputs: Array.from(t?.outputs ?? ["@primary"]),
            onlyClasses: Array.from(t?.onlyClasses ?? []),
            floatClasses: Array.from(t?.floatClasses ?? []),
            shortcuts: t?.shortcuts ?? true
        }
    }
    onTilingConfigChanged: configTimer.restart()

    readonly property var command: ["/usr/bin/python3", Quickshell.shellPath("helpers/kwinir_bridge.py")]
        .concat(root.jobProgress ? ["--jobs"] : [])
        .concat(root.tilingEnabled ? ["--tiling"] : [])
        .concat(root.tilingEnabled && (Config.options?.tiling?.takeOverQuickTile ?? true) ? ["--quicktile"] : [])

    // Mirrors TILING_COMMANDS in helpers/kwinir_bridge.py, which stays authoritative; this copy
    // only lets IPC callers hear about a typo instead of "sent".
    readonly property var tilingCommands: ["focus-left", "focus-right", "focus-up", "focus-down",
        "move-column-left", "move-column-right", "move-window-up", "move-window-down", "consume-left",
        "consume-right", "expel", "consume-or-expel-left", "consume-or-expel-right", "cycle-width",
        "maximize-column", "center-column", "float-toggle", "relayout", "adopt", "focus-column",
        "send-to-slot", "toggle-mode", "snap-left", "snap-right", "snap-up", "snap-down", "split-region", "scroll-next", "scroll-prev"]

    /** Sends one command to the tiling script (the helper whitelists names). False if refused or not running. */
    function sendTiling(name: string, arg): bool {
        if (!root.tilingEnabled || !root.ready || !helper.running || root.tilingCommands.indexOf(name) < 0)
            return false
        helper.write(JSON.stringify({ type: "tiling-command", name: name, arg: arg ?? null }) + "\n")
        return true
    }

    function _parseSplits(raw): var {
        try {
            const o = JSON.parse(String(raw ?? "{}"))
            return (o && typeof o === "object" && !Array.isArray(o)) ? o : ({})
        } catch (e) { return ({}) }
    }

    function _canonSplits(o): string {
        const out = {}
        for (const k of Object.keys(o ?? {}).sort())
            out[k] = Array.from(o[k] ?? []).map(String).sort()
        return JSON.stringify(out)
    }

    // The tiler owns the split state while it runs and reports it; keep the config in step so the
    // splits survive a restart. Writes only on a real difference (the config echoes back unchanged).
    function _syncSplits(report): void {
        if (!report || report.enabled !== true || !report.splits) return
        const mine = root._canonSplits(report.splits)
        if (mine !== root._canonSplits(root._parseSplits(Config.options?.tiling?.regionSplits)))
            Config.setNestedValue("tiling.regionSplits", mine)
    }

    function _sendTilingConfig(): void {
        if (root.tilingEnabled && root.ready && helper.running)
            helper.write(JSON.stringify({ type: "tiling-config", config: root.tilingConfig }) + "\n")
    }

    property bool _restartPending: false
    onCommandChanged: if (helper.running) root._restart(300)

    function _restart(delay: int): void {
        root._restartPending = true
        restartTimer.interval = delay
        restartTimer.restart()
    }

    function _handle(line: string): void {
        let event = null
        try { event = JSON.parse(line) } catch (e) { return }
        if (!event || typeof event !== "object")
            return
        switch (event.type) {
        case "ready": root.ready = true; root._sendTilingConfig(); break
        case "tiling": root.tiling = event; root._syncSplits(event); break
        case "fullscreen": root.fullscreen = event.value === true; break
        case "capture": root.capture = event.value === true; break
        case "jobs": root.activeJobs = Math.max(0, Number(event.count) || 0); break
        case "output": root.activeOutput = String(event.value ?? ""); root.outputPolled(root.activeOutput); break
        case "overview": root.overview = event.value === true; root.overviewPolled(root.overview); break
        }
    }

    Process {
        id: helper
        running: root.enabled && !root._restartPending
        stdinEnabled: true
        command: root.command
        stdout: SplitParser { onRead: line => root._handle(line) }
        stderr: SplitParser { onRead: line => console.info(line) }
        onExited: (code, status) => {
            root.ready = false
            root.fullscreen = false
            root.capture = false
            root.activeJobs = 0
            root.activeOutput = ""
            root.overview = false
            root.tiling = { enabled: false, outputs: ({}) }
            if (root.enabled && !root._restartPending) {
                console.warn(`[KWinBridge] helper exited (${code}), restarting in 5 s`)
                root._restart(5000)
            }
        }
    }

    // Coalesces settings edits (a spin box drag) into one config message.
    Timer {
        id: configTimer
        interval: 200
        onTriggered: root._sendTilingConfig()
    }

    Timer {
        id: restartTimer
        interval: 5000
        onTriggered: root._restartPending = false
    }
}
