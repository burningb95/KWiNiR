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
 *   - file-transfer progress: it owns org.kde.JobViewServer and shows KIO jobs
 *     (Dolphin copies, downloads) as progress notifications
 *     (notifications.jobProgress, default on);
 *   - KWin state: focused output and overview, polled in-process (no gdbus spawns);
 *     KWinService uses these while `statePolled` and falls back to its own poll.
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
    property int activeJobs: 0
    property string activeOutput: ""
    property bool overview: false
    readonly property bool statePolled: root.ready && root.activeOutput !== ""
    // Emitted on every poll report (not just on change), so consumers re-assert state.
    signal outputPolled(string name)
    signal overviewPolled(bool open)

    readonly property var command: ["/usr/bin/python3", Quickshell.shellPath("helpers/kwinir_bridge.py")]
        .concat(root.jobProgress ? ["--jobs"] : [])

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
        case "ready": root.ready = true; break
        case "fullscreen": root.fullscreen = event.value === true; break
        case "jobs": root.activeJobs = Math.max(0, Number(event.count) || 0); break
        case "output": root.activeOutput = String(event.value ?? ""); root.outputPolled(root.activeOutput); break
        case "overview": root.overview = event.value === true; root.overviewPolled(root.overview); break
        }
    }

    Process {
        id: helper
        running: root.enabled && !root._restartPending
        command: root.command
        stdout: SplitParser { onRead: line => root._handle(line) }
        stderr: SplitParser { onRead: line => console.info(line) }
        onExited: (code, status) => {
            root.ready = false
            root.fullscreen = false
            root.activeJobs = 0
            root.activeOutput = ""
            root.overview = false
            if (root.enabled && !root._restartPending) {
                console.warn(`[KWinBridge] helper exited (${code}), restarting in 5 s`)
                root._restart(5000)
            }
        }
    }

    Timer {
        id: restartTimer
        interval: 5000
        onTriggered: root._restartPending = false
    }
}
