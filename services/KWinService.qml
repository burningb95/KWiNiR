pragma Singleton
pragma ComponentBehavior: Bound

import QtQuick
import Quickshell
import Quickshell.Io

/**
 * KWin backend for the pill bar, shaped to match the slice of NiriService that
 * the bar actually consumes (see docs/KWIN_PORT.md for the mapping).
 *
 * Quickshell 0.3.1 exposes no generic D-Bus client to QML, so every call shells
 * out through `gdbus`, exactly as NiriService shells out to `niri msg`. State is
 * event-driven, not polled: `gdbus monitor` on org.kde.KWin streams
 * VirtualDesktopManager signals and each one triggers a targeted refresh.
 *
 * The one exception is `currentOutput`. KWin emits no signal when window focus
 * moves between monitors, so activeOutputName() is re-read on desktop changes
 * and otherwise on a slow timer. Consumers that need it exactly (Brightness)
 * call refreshActiveOutput() at the moment they act.
 *
 * Deliberately not implemented, because KWin has no equivalent:
 *   - isOverviewHotCornerActive(): electric-border hover state is not queryable.
 *   - liveWindows / per-workspace active_window_id: KWin supports no
 *     foreign-toplevel protocol, so there is no window list available to
 *     Quickshell. GameMode already treats this as false on non-niri.
 */
Singleton {
    id: root

    readonly property string dest: "org.kde.KWin"

    /**
     * Workspaces in niri's shape. KWin virtual desktops are global rather than
     * per-output, so `output` is intentionally left empty and PillWorkspaces
     * skips its output filter on KWin. `idx` is 1-based to match both niri's
     * workspace index and KWin's setCurrentDesktop().
     */
    property var allWorkspaces: []
    property string currentDesktopId: ""
    property string currentOutput: ""
    property bool inOverview: false

    // Kept so GameMode/PillBar bindings resolve; empty on KWin by design.
    property var workspaces: ({})
    property var outputs: ({})
    property var liveWindows: []

    readonly property bool ready: root.allWorkspaces.length > 0

    function switchToWorkspace(idx): void {
        const n = parseInt(idx, 10);
        if (!(n >= 1))
            return;
        setDesktopProc.command = ["gdbus", "call", "--session", "--dest", root.dest,
            "--object-path", "/KWin", "--method", "org.kde.KWin.setCurrentDesktop", String(n)];
        setDesktopProc.running = false;
        setDesktopProc.running = true;
    }

    function powerOffMonitors(): void {
        dpmsProc.command = ["kscreen-doctor", "--dpms", "off"];
        dpmsProc.running = false;
        dpmsProc.running = true;
    }

    function powerOnMonitors(): void {
        dpmsProc.command = ["kscreen-doctor", "--dpms", "on"];
        dpmsProc.running = false;
        dpmsProc.running = true;
    }

    /** No KWin equivalent; see the header note. */
    function isOverviewHotCornerActive(output, corner): bool {
        return false;
    }

    function refreshDesktops(): void {
        desktopsProc.running = false;
        desktopsProc.running = true;
    }

    function refreshCurrent(): void {
        currentProc.running = false;
        currentProc.running = true;
    }

    function refreshActiveOutput(): void {
        outputProc.running = false;
        outputProc.running = true;
    }

    function refreshOverview(): void {
        effectsProc.running = false;
        effectsProc.running = true;
    }

    function _rebuild(): void {
        const out = [];
        for (let i = 0; i < root._desktops.length; i++) {
            const d = root._desktops[i];
            out.push({
                idx: d.position + 1,
                id: d.id,
                name: d.name,
                output: "",
                is_focused: d.id === root.currentDesktopId,
                // Truthy so PillWorkspaces' trailing-empty-workspace trim, which
                // exists for niri's auto-created workspace, never drops a real
                // KWin desktop. KWin does not create or destroy desktops itself.
                active_window_id: 1
            });
        }
        root.allWorkspaces = out;
    }

    property var _desktops: []

    Process {
        id: desktopsProc
        command: ["gdbus", "call", "--session", "--dest", root.dest, "--object-path",
            "/VirtualDesktopManager", "--method", "org.freedesktop.DBus.Properties.Get",
            "org.kde.KWin.VirtualDesktopManager", "desktops"]
        stdout: StdioCollector {
            onStreamFinished: {
                // (<[(uint32 0, 'uuid', 'Desktop 1'), (1, 'uuid', 'Desktop 2')]>,)
                const re = /\((?:uint32\s+)?(\d+),\s*'([^']*)',\s*'([^']*)'\)/g;
                const list = [];
                let m;
                while ((m = re.exec(this.text)) !== null)
                    list.push({ position: parseInt(m[1], 10), id: m[2], name: m[3] });
                list.sort((a, b) => a.position - b.position);
                root._desktops = list;
                root._rebuild();
            }
        }
    }

    Process {
        id: currentProc
        command: ["gdbus", "call", "--session", "--dest", root.dest, "--object-path",
            "/VirtualDesktopManager", "--method", "org.freedesktop.DBus.Properties.Get",
            "org.kde.KWin.VirtualDesktopManager", "current"]
        stdout: StdioCollector {
            onStreamFinished: {
                const m = /'([^']+)'/.exec(this.text);
                if (m) {
                    root.currentDesktopId = m[1];
                    root._rebuild();
                }
            }
        }
    }

    Process {
        id: outputProc
        command: ["gdbus", "call", "--session", "--dest", root.dest, "--object-path",
            "/KWin", "--method", "org.kde.KWin.activeOutputName"]
        stdout: StdioCollector {
            onStreamFinished: {
                const m = /'([^']*)'/.exec(this.text);
                if (m)
                    root.currentOutput = m[1];
            }
        }
    }

    Process {
        id: effectsProc
        command: ["gdbus", "call", "--session", "--dest", root.dest, "--object-path",
            "/Effects", "--method", "org.freedesktop.DBus.Properties.Get",
            "org.kde.kwin.Effects", "activeEffects"]
        stdout: StdioCollector {
            onStreamFinished: {
                root.inOverview = /'overview'/.test(this.text);
            }
        }
    }

    Process { id: setDesktopProc }
    Process { id: dpmsProc }

    /**
     * Live signal stream. Each KWin signal maps to the narrowest refresh that
     * can change, so a desktop switch costs one gdbus call, not a full reload.
     */
    Process {
        id: monitor
        running: true
        // KWin port: setpriv --pdeathsig so the monitor dies with the bar (no orphans after a crash/kill).
        command: ["/usr/bin/setpriv", "--pdeathsig", "TERM", "--", "gdbus", "monitor", "--session", "--dest", "org.kde.KWin"]
        stdout: SplitParser {
            splitMarker: "\n"
            onRead: line => {
                if (line.indexOf("VirtualDesktopManager.currentChanged") !== -1) {
                    const m = /'([0-9a-fA-F-]{36})'/.exec(line);
                    if (m) {
                        root.currentDesktopId = m[1];
                        root._rebuild();
                    } else {
                        root.refreshCurrent();
                    }
                    root.refreshActiveOutput();
                    return;
                }
                if (line.indexOf("VirtualDesktopManager.countChanged") !== -1
                    || line.indexOf("VirtualDesktopManager.desktopCreated") !== -1
                    || line.indexOf("VirtualDesktopManager.desktopRemoved") !== -1
                    || line.indexOf("VirtualDesktopManager.desktopDataChanged") !== -1) {
                    root.refreshDesktops();
                    root.refreshCurrent();
                }
            }
        }
        // If the stream ever ends, restart it and re-read everything it may have missed.
        onExited: monitorRestart.restart()
    }

    Timer {
        id: monitorRestart
        interval: 2000
        onTriggered: {
            monitor.running = true;
            root.refreshDesktops();
            root.refreshCurrent();
        }
    }

    Timer {
        interval: 5000
        running: true
        repeat: true
        onTriggered: {
            root.refreshActiveOutput();
            root.refreshOverview();
        }
    }

    Component.onCompleted: {
        root.refreshDesktops();
        root.refreshCurrent();
        root.refreshActiveOutput();
        root.refreshOverview();
    }
}
