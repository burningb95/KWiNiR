pragma Singleton

import QtQuick
import qs.modules.common
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.services

/**
 * Night light service with automatic mode.
 * Uses hyprsunset on Hyprland, wlsunset on Niri.
 */
Singleton {
    id: root
    property string from: Config.options?.light?.night?.from ?? "19:00" 
    property string to: Config.options?.light?.night?.to ?? "06:30"
    property bool automatic: Config.options?.light?.night?.automatic && (Config?.ready ?? true)
    property bool manualEnabled: Config.options?.light?.night?.enabled ?? false
    property int colorTemperature: Config.options?.light?.night?.colorTemperature ?? 5000
    property bool shouldBeOn
    property bool firstEvaluation: true
    property bool active: false

    property int fromHour: Number(from.split(":")[0])
    property int fromMinute: Number(from.split(":")[1])
    property int toHour: Number(to.split(":")[0])
    property int toMinute: Number(to.split(":")[1])

    property int clockHour: DateTime.clock.hours
    property int clockMinute: DateTime.clock.minutes

    property var manualActive
    property int manualActiveHour
    property int manualActiveMinute

    // Debounce timer for wlsunset restarts
    property bool _pendingRestart: false
    Timer {
        id: restartDebounce
        interval: 300
        onTriggered: {
            if (root._pendingRestart && root.active) {
                root._doEnable()
            }
            root._pendingRestart = false
        }
    }

    onClockMinuteChanged: reEvaluate()
    onAutomaticChanged: {
        root.manualActive = undefined;
        root.firstEvaluation = true;
        reEvaluate();
    }

    function inBetween(t, from, to) {
        if (from < to) {
            return (t >= from && t <= to);
        } else {
            // Wrapped around midnight
            return (t >= from || t <= to);
        }
    }

    function reEvaluate() {
        const t = clockHour * 60 + clockMinute;
        const from = fromHour * 60 + fromMinute;
        const to = toHour * 60 + toMinute;
        const manualActive = manualActiveHour * 60 + manualActiveMinute;

        if (root.manualActive !== undefined && (inBetween(from, manualActive, t) || inBetween(to, manualActive, t))) {
            root.manualActive = undefined;
        }
        root.shouldBeOn = inBetween(t, from, to);
        if (firstEvaluation) {
            firstEvaluation = false;
            root.ensureState();
        }
    }

    onShouldBeOnChanged: ensureState()
    function ensureState() {
        if (root.manualActive !== undefined)
            return;

        if (root.automatic) {
            if (root.shouldBeOn) {
                root.enable();
            } else {
                root.disable();
            }
        } else if (root.manualEnabled) {
            root.enable();
        } else {
            root.disable();
        }
    }

    function load() { } // Dummy to force init

    function _doEnable() {
        if (CompositorService.isKWin) {
            root._kwinApply(true)
            return
        }
        if (CompositorService.isNiri) {
            // Keep night light outside inir.service's cgroup. It must survive
            // shell reloads without being reported as a leaked child process.
            // A transient user unit also gives us a precise lifecycle owner.
            Quickshell.execDetached([
                "/usr/bin/systemd-run", "--user", "--collect",
                "--unit=inir-wlsunset.service",
                "/usr/bin/wlsunset", "-T", "6500", "-t",
                root.colorTemperature.toString(), "-s", "00:00", "-S", "23:59"
            ]);
        } else {
            hyprsunsetStartProc.running = true;
        }
    }

    function enable() {
        root.active = true;
        if (CompositorService.isKWin) {
            root._kwinApply(true);
            return;
        }
        if (CompositorService.isNiri) {
            // Kill first, then start after kill completes
            wlsunsetKillProc.running = true;
        } else {
            root._doEnable();
        }
    }

    function disable() {
        root.active = false;
        if (CompositorService.isKWin) {
            root._kwinApply(false);
            return;
        }
        if (CompositorService.isNiri) {
            wlsunsetKillProc.running = true;
        } else {
            hyprsunsetKillProc.running = true;
        }
    }

    function fetchState() {
        if (CompositorService.isKWin) {
            kwinFetchProc.running = true;
            return;
        }
        if (CompositorService.isNiri) {
            niriFetchProc.running = true;
        } else {
            fetchProc.running = true;
        }
    }

    // === Hyprland processes ===
    Process {
        id: hyprsunsetStartProc
        command: ["/usr/bin/bash", "-c", `pidof hyprsunset || /usr/bin/hyprsunset --temperature ${root.colorTemperature}`]
    }

    Process {
        id: hyprsunsetKillProc
        command: ["/usr/bin/pkill", "-x", "hyprsunset"]
    }

    Process {
        id: fetchProc
        running: !CompositorService.isNiri && !CompositorService.isKWin
        command: ["/usr/bin/bash", "-c", "hyprctl hyprsunset temperature"]
        stdout: StdioCollector {
            id: stateCollector
            onStreamFinished: {
                const output = stateCollector.text.trim();
                if (output.length == 0 || output.startsWith("Couldn't"))
                    root.active = false;
                else
                    root.active = (output != "6500"); // 6500 is the default when off
            }
        }
    }

    // === KWin (KWin Night Light) ===
    // KWin port: the filter is KWin's own Night Light in Constant mode; iNiR's
    // schedule/manual logic above still decides when it is on. Settings go to
    // kwinrc [NightColor] with KConfig change notifications (--notify), which is
    // how KWin's KConfigWatcher picks them up (like System Settings). Unchanged
    // values are not rewritten, so re-applying the same state is free.
    // Undo: REVERT-nightlight.sh in ~/.local/share/Fancy-Floating-Bar.
    readonly property int _kwinTemperature: Math.max(1000, Math.min(6500, Math.round(root.colorTemperature)))
    property var _kwinPending: null

    function _kwinApply(on: bool): void {
        const want = { active: on, temperature: root._kwinTemperature }
        if (kwinWriteProc.running) {
            root._kwinPending = want
            return
        }
        kwinWriteProc.command = ["/usr/bin/bash", "-c",
            'k() { /usr/bin/kwriteconfig6 --file kwinrc --group NightColor --key "$1" --notify "$2"; }; '
            + 'k Mode Constant && k NightTemperature "$2" && k Active "$1"',
            "bash", want.active ? "true" : "false", String(want.temperature)]
        kwinWriteProc.running = true
    }

    Process {
        id: kwinWriteProc
        onExited: (exitCode, exitStatus) => {
            if (exitCode !== 0)
                console.warn("[NightLight] kwriteconfig6 failed:", exitCode)
            if (root._kwinPending) {
                const next = root._kwinPending
                root._kwinPending = null
                root._kwinApply(next.active)
            }
        }
    }

    function _kwinParseEnabled(text: string): void {
        const m = /'enabled':\s*<(true|false)>|\(<(true|false)>,\)/.exec(String(text))
        if (m)
            root.active = (m[1] ?? m[2]) === "true"
    }

    Process {
        id: kwinFetchProc
        running: CompositorService.isKWin
        command: ["/usr/bin/gdbus", "call", "--session", "--dest", "org.kde.KWin",
            "--object-path", "/org/kde/KWin/NightLight", "--method",
            "org.freedesktop.DBus.Properties.Get", "org.kde.KWin.NightLight", "enabled"]
        stdout: StdioCollector { onStreamFinished: root._kwinParseEnabled(text) }
    }

    // Follow changes made elsewhere too (System Settings, another toggle): KWin
    // emits PropertiesChanged on /org/kde/KWin/NightLight. Event-driven, no polling.
    Process {
        id: kwinMonitorProc
        running: CompositorService.isKWin
        command: ["/usr/bin/setpriv", "--pdeathsig", "TERM", "--", "/usr/bin/gdbus", "monitor", "--session", "--dest", "org.kde.KWin",
            "--object-path", "/org/kde/KWin/NightLight"]
        stdout: SplitParser { onRead: line => { if (line.indexOf("'enabled'") >= 0) root._kwinParseEnabled(line) } }
        onExited: if (CompositorService.isKWin) kwinMonitorRestart.restart()
    }
    Timer {
        id: kwinMonitorRestart
        interval: 5000
        onTriggered: kwinMonitorProc.running = true
    }

    // === Niri processes (wlsunset) ===
    Process {
        id: wlsunsetKillProc
        // Stop the owned transient service. pkill is retained only to clean up
        // pre-2.30 legacy instances that were spawned directly by Quickshell.
        command: ["/usr/bin/bash", "-c",
            "/usr/bin/systemctl --user stop inir-wlsunset.service >/dev/null 2>&1 || true; "
            + "/usr/bin/pkill -x wlsunset >/dev/null 2>&1 || true"]
        onExited: {
            // If we're enabling, start wlsunset after kill completes
            if (root.active) {
                root._doEnable();
            }
        }
    }

    Process {
        id: niriFetchProc
        running: CompositorService.isNiri
        command: ["/usr/bin/bash", "-c",
            "/usr/bin/systemctl --user is-active --quiet inir-wlsunset.service "
            + "|| /usr/bin/pidof wlsunset >/dev/null"]
        onExited: (exitCode, exitStatus) => {
            root.active = (exitCode === 0);
        }
    }

    function toggle(active = undefined) {
        if (root.manualActive === undefined) {
            root.manualActive = root.active;
            root.manualActiveHour = root.clockHour;
            root.manualActiveMinute = root.clockMinute;
        }

        root.manualActive = active !== undefined ? active : !root.manualActive;
        Config.setNestedValue("light.night.enabled", root.manualActive);
        if (root.manualActive) {
            root.enable();
        } else {
            root.disable();
        }
    }

    // React to temperature changes while active
    Connections {
        target: Config.options?.light?.night ?? null
        enabled: !!(Config.options?.light?.night)
        
        function onColorTemperatureChanged() {
            if (!root.active) return;
            const temp = Config.options?.light?.night?.colorTemperature ?? root.colorTemperature;
            
            if (CompositorService.isKWin) {
                root._kwinApply(true);
            } else if (CompositorService.isNiri) {
                // Queue restart with debounce
                root._pendingRestart = true;
                restartDebounce.restart();
            } else {
                Quickshell.execDetached(["/usr/bin/hyprctl", "hyprsunset", "temperature", `${temp}`]);
            }
        }
    }

    // React to schedule changes while automatic mode is on
    Connections {
        target: Config.options?.light?.night ?? null
        enabled: root.automatic && !!(Config.options?.light?.night)
        
        function onFromChanged() {
            root.firstEvaluation = true;
            root.reEvaluate();
        }
        
        function onToChanged() {
            root.firstEvaluation = true;
            root.reEvaluate();
        }
    }
}
