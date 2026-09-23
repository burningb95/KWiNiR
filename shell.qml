//@ pragma UseQApplication
// KWin port: this shell's own icon theme (tray, launcher, notification, media and
// mixer app icons). Process-local: the desktop's icon theme is not touched.
//@ pragma IconTheme candy-icons

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs
import qs.modules.common
import qs.services
import qs.modules.notificationPopup
import qs.modules.pill
import qs.modules.sidebarLeft
import qs.modules.sidebarRight

/**
 * Standalone entry point for iNiR's Material ii pill bar and both sidebars on KWin.
 *
 * Upstream iNiR loads these through shell.qml -> the ii family host
 * (modules/ii/ShellIiPanelsImpl.qml), which also brings in every other ii panel
 * (background, dock, overview, lock, ...). None of that is wanted here, so each
 * piece is instantiated directly. PillBar, SidebarLeft and SidebarRight are all
 * Scopes that own their own Variants/PanelWindow per screen.
 *
 * They must share this one process: the pill's sidebar button calls
 * GlobalStates.toggleSidebarLeft/Right(), and GlobalStates is an in-process singleton.
 * A sidebar in a separate Quickshell instance would never see that toggle.
 *
 * Two small pieces of the ii host are lifted verbatim below, because the sidebar
 * does not work on KWin without them. Nothing else from the host is used.
 */
ShellRoot {
    id: shellRoot

    // Verbatim from ShellIiPanelsImpl.qml.
    function screensFor(list: var): var {
        const screens = Quickshell.screens
        if (!list || list.length === 0)
            return screens
        const matched = screens.filter(screen => {
            const screenName = screen?.name ?? ""
            return screenName.length > 0 && list.includes(screenName)
        })
        return matched.length > 0 ? matched : screens
    }

    PillBar {}

    /**
     * Notification popups, rule verbatim from ShellIiPanelsImpl.qml. The pill shows
     * notifications itself as toasts on the screens it hosts (bar.pill.toasts), so
     * the standalone popup only appears on notification screens the pill doesn't
     * cover — with this config, DP-3.
     */
    readonly property bool pillHostActive: (Config.options?.bar?.appearanceStyle ?? "classic") === "pill"
        && !(Config.options?.bar?.vertical ?? false)
        && (Config.options?.enabledPanels ?? []).includes("iiBar")
    readonly property bool pillToastTakeover: shellRoot.pillHostActive
        && (Config.options?.bar?.pill?.toasts ?? true)
    readonly property var pillHostScreenNames: (shellRoot.pillHostActive
        ? shellRoot.screensFor(Config.options?.bar?.screenList ?? []) : []).map(screen => screen?.name ?? "")
    readonly property var notificationScreens: shellRoot.screensFor(Config.options?.notifications?.screenList ?? [])
    readonly property bool notificationStandaloneNeeded: !shellRoot.pillToastTakeover
        || shellRoot.notificationScreens.some(screen => !shellRoot.pillHostScreenNames.includes(screen?.name ?? ""))

    LazyLoader {
        active: Config.ready && shellRoot.notificationStandaloneNeeded
            && (Config.options?.enabledPanels ?? []).includes("iiNotificationPopup")
        NotificationPopup {
            excludedScreenNames: shellRoot.pillToastTakeover ? shellRoot.pillHostScreenNames : []
        }
    }
    SidebarLeft {}
    SidebarRight {}

    /**
     * Wake the color loader. It is a lazily created singleton and nothing in the
     * bar or sidebar touches it, so without this Appearance keeps its built-in
     * defaults (saturated blue on navy) instead of the seeded palette.
     *
     * Upstream does this through ThemeService.applyCurrentTheme(), which in auto
     * mode runs switchwall.sh for "full regeneration from wallpaper (includes
     * terminals, GTK, etc)", alongside IconThemeService.ensureInitialized().
     * Neither is called here. MaterialThemeLoader.reapplyTheme() only reads
     * colors.json into Appearance.m3colors, and its external-theming hook is
     * hard-disabled (defaultApplyExternal: false).
     */
    Connections {
        target: Config
        function onReadyChanged(): void {
            if (Config.ready)
                Qt.callLater(() => MaterialThemeLoader.reapplyTheme())
        }
    }
    Component.onCompleted: {
        if (Config.ready)
            Qt.callLater(() => MaterialThemeLoader.reapplyTheme())
    }

    /**
     * KWin port: caffeine. Every idle toggle (both quick-toggle styles and the
     * left sidebar's tools view) flips Idle.inhibit, but upstream only acts on it
     * by stopping its own swayidle — which never runs on KWin, where Plasma's
     * PowerDevil owns idle. The Wayland idle-inhibit protocol
     * (zwp_idle_inhibit_manager_v1) is what KWin and PowerDevil actually honor,
     * the same mechanism video players use to keep the screen awake.
     *
     * An inhibitor has to hang off a mapped surface, so this is a dedicated
     * 1x1 transparent layer surface with an empty input region: it never draws
     * anything visible and never receives a click. Only created on KWin.
     */
    LazyLoader {
        active: CompositorService.isKWin

        PanelWindow {
            id: idleInhibitSurface
            implicitWidth: 1
            implicitHeight: 1
            color: "transparent"
            exclusiveZone: 0
            anchors { top: true; left: true }
            WlrLayershell.namespace: "quickshell:idleInhibit"
            WlrLayershell.layer: WlrLayer.Background
            WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
            mask: Region {}

            IdleInhibitor {
                window: idleInhibitSurface
                enabled: Idle.inhibit
            }
        }
    }

    /**
     * KWin port: clipboard history. The pill's clipboard surface reads cliphist,
     * but on Plasma nothing stores into it (Klipper keeps its own history), so
     * the bar runs the watcher itself while clipboard.historyWatcher is on.
     * It is a child of this process: it stops with the bar. cliphist skips
     * entries marked sensitive (x-kde-passwordManagerHint), so password-manager
     * copies are not recorded.
     */
    Process {
        id: cliphistWatcher
        running: CompositorService.isKWin && Config.ready
            && (Config.options?.clipboard?.historyWatcher ?? true)
        command: ["/usr/bin/wl-paste", "--watch", "/usr/bin/cliphist", "store"]
        onExited: (code, status) => {
            if (CompositorService.isKWin && (Config.options?.clipboard?.historyWatcher ?? true)) {
                console.warn("[Clipboard] cliphist watcher exited (" + code + "), restarting in 5s")
                cliphistRestart.restart()
            }
        }
    }
    Timer {
        id: cliphistRestart
        interval: 5000
        onTriggered: {
            cliphistWatcher.running = false
            cliphistWatcher.running = Qt.binding(() => CompositorService.isKWin && Config.ready
                && (Config.options?.clipboard?.historyWatcher ?? true))
        }
    }

    /**
     * Click-outside dismissal, verbatim from ShellIiPanelsImpl.qml (only
     * `panelsRoot` renamed to `shellRoot`). SidebarHost closes itself on focus
     * loss only through CompositorFocusGrab, which is Hyprland-only; on every
     * other compositor upstream relies on this transparent full-screen catcher.
     * KWin takes that path. It masks to nothing while no sidebar is open, so it
     * never intercepts clicks otherwise.
     */
    Variants {
        model: shellRoot.screensFor(Config.options?.sidebar?.screenList ?? [])

        PanelWindow {
            id: dualSidebarBackdrop
            required property var modelData
            readonly property bool leftPresented: GlobalStates.sidebarLeftOpen
                && GlobalStates.sidebarLeftPresentationOutput === (modelData?.name ?? "")
            readonly property bool rightPresented: GlobalStates.sidebarRightOpen
                && GlobalStates.sidebarRightPresentationOutput === (modelData?.name ?? "")
            screen: modelData
            visible: leftPresented || rightPresented
            updatesEnabled: leftPresented || rightPresented
            color: "transparent"
            exclusiveZone: 0
            WlrLayershell.namespace: "quickshell:dualSidebarBackdrop"
            WlrLayershell.layer: WlrLayer.Top
            WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

            anchors {
                top: true
                bottom: true
                left: true
                right: true
            }

            Item { id: emptyDualSidebarMask; width: 0; height: 0 }
            mask: Region {
                item: dualSidebarBackdrop.leftPresented || dualSidebarBackdrop.rightPresented
                    ? dualSidebarBackdropArea : emptyDualSidebarMask
            }

            MouseArea {
                id: dualSidebarBackdropArea
                anchors.fill: parent
                enabled: dualSidebarBackdrop.leftPresented || dualSidebarBackdrop.rightPresented
                onClicked: {
                    if (dualSidebarBackdrop.leftPresented)
                        GlobalStates.closeSidebarLeft()
                    if (dualSidebarBackdrop.rightPresented)
                        GlobalStates.closeSidebarRight()
                }
            }
        }
    }

    /**
     * Verbatim from upstream shell.qml. Upstream also binds these through
     * Quickshell.Hyprland GlobalShortcut, which uses Hyprland's own
     * global-shortcuts protocol and cannot work on KWin. Bind a KWin custom
     * shortcut to `qs -c pillbar ipc call sidebarRight toggle` instead.
     */
    /**
     * KWin port addition (upstream has no idle IPC). Lets a KWin custom shortcut
     * drive caffeine: `qs -c pillbar ipc call idle toggle`.
     */
    IpcHandler {
        target: "idle"
        function toggle(): void { Idle.toggleInhibit() }
        function on(): void { Idle.toggleInhibit(true) }
        function off(): void { Idle.toggleInhibit(false) }
        function state(): string { return Idle.inhibit ? "inhibited" : "normal" }
    }

    /** KWin port: burningb95's palettes (extras/theme). `palette apply plum` */
    IpcHandler {
        target: "palette"
        function apply(name: string): string { return UserPalettes.apply(name) ? "applied " + name : "unknown palette" }
        function list(): string { return UserPalettes.names.join(" ") }
        function current(): string { return UserPalettes.current }
    }

    IpcHandler {
        target: "sidebarLeft"
        function toggle(): void { GlobalStates.toggleSidebarLeft("") }
        function close(): void { GlobalStates.closeSidebarLeft() }
        function open(): void { GlobalStates.openSidebarLeft("") }
    }

    IpcHandler {
        target: "sidebarRight"
        function toggle(): void { GlobalStates.toggleSidebarRight("") }
        function close(): void { GlobalStates.closeSidebarRight() }
        function open(): void { GlobalStates.openSidebarRight("") }
    }

    /**
     * Upstream's "settings" target, minus the overlay variants (the settings
     * overlay isn't extracted). Opens the standalone settings.qml window.
     */
    IpcHandler {
        target: "settings"
        function open(): void { GlobalStates.openSettings() }
        function toggle(): void { GlobalStates.toggleSettings() }
        function openWindowAt(index: int): void { GlobalStates.openSettingsPage(index, "") }
    }
}
