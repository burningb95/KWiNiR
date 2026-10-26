import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.services
import qs.modules.common
import qs.modules.common.widgets

// KWin port: scrolling tiling (helpers/kwinir-tiling.js). New page, not upstream's: the Layout
// section borrows the shape of NiriConfig's Layout card (gaps, focus centring, single-column
// options, struts) and writes tiling.* instead of niri's config.kdl. The bridge pushes every
// change to the running tiler without a restart (only tiling.enable restarts the helper).
ContentPage {
    id: root
    settingsPageIndex: 29
    settingsPageName: Translation.tr("Tiling")
    property string activeSection: "layout"

    SettingsTaskNavigator {
        icon: "view_column"
        title: Translation.tr("Tiling")
        description: Translation.tr("niri-style scrolling columns on KWin, or fixed regions from KDE's tile editor: which monitors tile and how, spacing, portrait behaviour, which apps stay floating, and the keys.")
        summary: Translation.tr("Layout · regions · apps · keys")
        currentValue: root.activeSection
        onSelected: value => root.activeSection = value
        searchAliases: ({
            "gaps": "layout",
            "struts": "layout",
            "portrait": "layout",
            "dock": "layout",
            "regions": "regions",
            "slots": "regions",
            "zones": "regions",
            "tile editor": "regions",
            "float": "apps",
            "never tile": "apps",
            "shortcuts": "keys",
            "keybindings": "keys"
        })
        options: [
            { displayName: Translation.tr("Layout"), icon: "grid_view", value: "layout" },
            { displayName: Translation.tr("Regions"), icon: "dashboard", value: "regions" },
            { displayName: Translation.tr("Apps"), icon: "apps", value: "apps" },
            { displayName: Translation.tr("Keys"), icon: "keyboard", value: "keys" }
        ]
    }

    // Class lists (only-these-apps / never-tile). Written on user action only.
    function listAdd(key: string, cls: string): void {
        const v = String(cls).trim()
        const cur = Array.from(Config.options?.tiling?.[key] ?? [])
        if (!/^[A-Za-z0-9._@+*-]{1,100}$/.test(v) || cur.includes(v))
            return
        cur.push(v)
        Config.setNestedValue("tiling." + key, cur)
    }

    function listRemove(key: string, cls: string): void {
        Config.setNestedValue("tiling." + key, Array.from(Config.options?.tiling?.[key] ?? []).filter(c => c !== cls))
    }

    SettingsTaskLoader {
        requested: root.activeSection === "layout"
        sourceComponent: Component {
    SettingsCardSection {
        settingsTaskSection: "layout"
        expanded: true
        icon: "grid_view"
        title: Translation.tr("Layout")

        SettingsGroup {
            ConfigSwitch {
                buttonIcon: "view_column"
                text: Translation.tr("Tile windows in scrolling columns")
                checked: Config.options?.tiling?.enable ?? true
                onCheckedChanged: Config.setNestedValue("tiling.enable", checked)
                StyledToolTip { text: Translation.tr("Turning it on tiles the windows already open (or only the apps you list); turning it off gives every window back. Columns scrolled out of view are minimized, and the minimize animation is switched off by game mode like the other effects.") }
            }

            ContentSubsection {
                title: Translation.tr("Monitors")
                ConfigSelectionArray {
                    currentValue: (Array.from(Config.options?.tiling?.outputs ?? ["@all"]).includes("@all")) ? "@all" : "@primary"
                    onSelected: newValue => Config.setNestedValue("tiling.outputs", [newValue])
                    options: [
                        { displayName: Translation.tr("Main monitor only"), icon: "monitor", value: "@primary" },
                        { displayName: Translation.tr("Every monitor"), icon: "monitor_weight", value: "@all" }
                    ]
                }
                StyledText {
                    Layout.fillWidth: true
                    text: Translation.tr("\"Main monitor\" is the one KDE ranks first (System Settings › Display), so it keeps working if the cables move. Dragging a window onto a monitor that does not tile leaves it floating there.")
                    color: Appearance.colors.colSubtext
                    font.pixelSize: Appearance.font.pixelSize.smaller
                    wrapMode: Text.WordWrap
                }
            }

            ContentSubsection {
                title: Translation.tr("Window gaps")
                tooltip: Translation.tr("Space between windows and screen edges in pixels")
                ConfigSpinBox {
                    icon: "padding"
                    text: Translation.tr("Gap size (px)")
                    value: Config.options?.tiling?.gap ?? 12
                    from: 0
                    to: 64
                    stepSize: 1
                    onValueChanged: Config.setNestedValue("tiling.gap", value)
                }
                StyledText {
                    Layout.fillWidth: true
                    text: Translation.tr("0 puts windows edge to edge, and dragging the border between two of them then trades width between the two.")
                    color: Appearance.colors.colSubtext
                    font.pixelSize: Appearance.font.pixelSize.smaller
                    wrapMode: Text.WordWrap
                }
            }

            ContentSubsection {
                title: Translation.tr("New column width")
                ConfigSpinBox {
                    icon: "width"
                    text: Translation.tr("% of the screen")
                    value: Math.round((Config.options?.tiling?.defaultWidth ?? 0.5) * 100)
                    from: 20
                    to: 100
                    stepSize: 5
                    onValueChanged: Config.setNestedValue("tiling.defaultWidth", value / 100)
                }
            }

            ContentSubsection {
                title: Translation.tr("Focus behavior")
                tooltip: Translation.tr("When to center the focused column on screen")
                ConfigSelectionArray {
                    currentValue: Config.options?.tiling?.center ?? "on-overflow"
                    onSelected: newValue => Config.setNestedValue("tiling.center", newValue)
                    options: [
                        { displayName: Translation.tr("Never"), icon: "align_horizontal_left", value: "never" },
                        { displayName: Translation.tr("On overflow"), icon: "align_horizontal_center", value: "on-overflow" },
                        { displayName: Translation.tr("Always"), icon: "center_focus_strong", value: "always" }
                    ]
                }
            }

            ConfigSwitch {
                Layout.fillWidth: true
                buttonIcon: "layers"
                text: Translation.tr("New windows open over the focused window")
                checked: Config.options?.tiling?.newWindowOverlay ?? true
                onCheckedChanged: Config.setNestedValue("tiling.newWindowOverlay", checked)
                StyledToolTip { text: Translation.tr("A window you open (from Latte, a launcher, a terminal) sits exactly over a tiled window of the same app, or the focused one, instead of getting a column or region of its own. Nothing scrolls and nothing else is minimized. Move it into the grid with Meta + arrows or Meta+Alt+1…6, drag it out to float it, and closing it uncovers the window under it. The first window on a monitor still tiles normally.") }
            }

            ConfigSwitch {
                Layout.fillWidth: true
                buttonIcon: "center_focus_strong"
                text: Translation.tr("Always center a single column")
                checked: Config.options?.tiling?.centerSingle ?? false
                onCheckedChanged: Config.setNestedValue("tiling.centerSingle", checked)
            }

            ConfigSwitch {
                Layout.fillWidth: true
                buttonIcon: "fullscreen"
                text: Translation.tr("Auto-expand a single tiling window")
                checked: Config.options?.tiling?.expandSingle ?? false
                onCheckedChanged: Config.setNestedValue("tiling.expandSingle", checked)
            }

            StyledText {
                Layout.fillWidth: true
                text: Translation.tr("A lone window fills the screen. When a second window appears the first goes back to its normal width.")
                wrapMode: Text.WordWrap
                color: Appearance.colors.colSubtext
                font.pixelSize: Appearance.font.pixelSize.small
            }

            SettingsDivider {}

            ContentSubsection {
                title: Translation.tr("Portrait monitors")
                ConfigSwitch {
                    Layout.fillWidth: true
                    buttonIcon: "stay_current_portrait"
                    text: Translation.tr("Stack windows vertically")
                    checked: Config.options?.tiling?.portraitVertical ?? true
                    onCheckedChanged: Config.setNestedValue("tiling.portraitVertical", checked)
                    StyledToolTip { text: Translation.tr("On a portrait monitor the strip runs top to bottom: each new window is a full-width row. Up / Down then walk the rows and Left / Right move between windows side by side in one row.") }
                }
                ConfigSpinBox {
                    icon: "vertical_align_bottom"
                    text: Translation.tr("Dock strip at the bottom (px)")
                    value: Config.options?.tiling?.portraitDockStrip ?? 8
                    from: 0
                    to: 200
                    stepSize: 2
                    onValueChanged: Config.setNestedValue("tiling.portraitDockStrip", value)
                    StyledToolTip { text: Translation.tr("Windows on a portrait monitor stop this far above its bottom edge, so a dock added there later has its hover strip. Latte's own strip on the main monitor sits over the windows and needs nothing. 0 turns this off.") }
                }
            }

            SettingsDivider {}

            ContentSubsection {
                title: Translation.tr("Struts")
                tooltip: Translation.tr("Shrink the tiling area by this many pixels from each edge")
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                ConfigSpinBox {
                    Layout.fillWidth: true
                    text: Translation.tr("Left")
                    icon: "arrow_back"
                    value: Config.options?.tiling?.struts?.left ?? 0
                    from: 0
                    to: 512
                    stepSize: 8
                    onValueChanged: Config.setNestedValue("tiling.struts.left", value)
                }
                ConfigSpinBox {
                    Layout.fillWidth: true
                    text: Translation.tr("Right")
                    icon: "arrow_forward"
                    value: Config.options?.tiling?.struts?.right ?? 0
                    from: 0
                    to: 512
                    stepSize: 8
                    onValueChanged: Config.setNestedValue("tiling.struts.right", value)
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                ConfigSpinBox {
                    Layout.fillWidth: true
                    text: Translation.tr("Top")
                    icon: "arrow_upward"
                    value: Config.options?.tiling?.struts?.top ?? 0
                    from: 0
                    to: 512
                    stepSize: 8
                    onValueChanged: Config.setNestedValue("tiling.struts.top", value)
                }
                ConfigSpinBox {
                    Layout.fillWidth: true
                    text: Translation.tr("Bottom")
                    icon: "arrow_downward"
                    value: Config.options?.tiling?.struts?.bottom ?? 0
                    from: 0
                    to: 512
                    stepSize: 8
                    onValueChanged: Config.setNestedValue("tiling.struts.bottom", value)
                }
            }

            PageResetFooter {
                Layout.fillWidth: true
                scope: ["tiling"]
                description: Translation.tr("Puts every tiling option back (tiling on, every monitor, 12 px gaps).")
            }
        }
    }
        }
    }

    // Monitors that use fixed regions. Writes only on a real change (switches fire on init).
    function regionOutputOn(name: string): bool {
        return Array.from(Config.options?.tiling?.regionOutputs ?? []).includes(name)
    }

    function setRegionOutput(name: string, on: bool): void {
        const cur = Array.from(Config.options?.tiling?.regionOutputs ?? [])
        if (cur.includes(name) === on)
            return
        Config.setNestedValue("tiling.regionOutputs", on ? cur.concat([name]) : cur.filter(n => n !== name))
    }

    Process {
        id: tileEditor
        command: ["qdbus6", "org.kde.kglobalaccel", "/component/kwin", "org.kde.kglobalaccel.Component.invokeShortcut", "Edit Tiles"]
    }

    SettingsTaskLoader {
        requested: root.activeSection === "regions"
        sourceComponent: Component {
    SettingsCardSection {
        settingsTaskSection: "regions"
        expanded: true
        icon: "dashboard"
        title: Translation.tr("Regions")

        SettingsGroup {
            StyledText {
                Layout.fillWidth: true
                text: Translation.tr("A monitor in regions mode does not scroll: its windows sit in fixed slots, nothing is minimized, and a slot holds a stack of windows. The slots are the tiles of KDE's own tile layout for that monitor, so you edit them in KDE's tile editor (Meta+T) and the change shows up here within a couple of seconds.")
                color: Appearance.colors.colSubtext
                font.pixelSize: Appearance.font.pixelSize.smaller
                wrapMode: Text.WordWrap
            }

            RippleButtonWithIcon {
                materialIcon: "edit"
                mainText: Translation.tr("Open KDE's tile editor")
                onClicked: tileEditor.running = true
            }

            ContentSubsection {
                title: Translation.tr("Monitors using fixed regions")
                Repeater {
                    model: Quickshell.screens
                    ConfigSwitch {
                        required property var modelData
                        Layout.fillWidth: true
                        buttonIcon: "dashboard"
                        text: modelData.name + "  (" + modelData.width + "×" + modelData.height + ")"
                        checked: root.regionOutputOn(modelData.name)
                        onCheckedChanged: root.setRegionOutput(modelData.name, checked)
                    }
                }
                StyledText {
                    Layout.fillWidth: true
                    text: Translation.tr("Meta+Alt+G flips the focused monitor between scrolling columns and regions for the moment; this list is what it starts as. Only monitors that tile (Layout › Monitors) are affected.")
                    color: Appearance.colors.colSubtext
                    font.pixelSize: Appearance.font.pixelSize.smaller
                    wrapMode: Text.WordWrap
                }
            }

            ContentSubsection {
                title: Translation.tr("Where a new window goes")
                ConfigSelectionArray {
                    currentValue: Config.options?.tiling?.regionsNewWindow ?? "smart"
                    onSelected: newValue => Config.setNestedValue("tiling.regionsNewWindow", newValue)
                    options: [
                        { displayName: Translation.tr("Smart"), icon: "auto_awesome", value: "smart" },
                        { displayName: Translation.tr("Focused region"), icon: "center_focus_strong", value: "focused" }
                    ]
                }
                StyledText {
                    Layout.fillWidth: true
                    text: Translation.tr("Smart: the region already holding a window of the same app, otherwise the largest empty region, otherwise the focused one. Focused region: always where you are. Windows share a region by stacking.")
                    color: Appearance.colors.colSubtext
                    font.pixelSize: Appearance.font.pixelSize.smaller
                    wrapMode: Text.WordWrap
                }
            }

            StyledText {
                Layout.fillWidth: true
                text: Translation.tr("Meta+Alt+1…6 send the focused window to that region (left to right, or top to bottom, as in the editor). Ctrl+Meta+S splits the focused region into a top and a bottom half (again to merge them). Meta + arrows move a window to the neighbouring region. Dragging a window drops it into the region under it. Region borders are fixed: resize them in the tile editor.")
                color: Appearance.colors.colSubtext
                font.pixelSize: Appearance.font.pixelSize.smaller
                wrapMode: Text.WordWrap
            }

            PageResetFooter {
                Layout.fillWidth: true
                scope: ["tiling"]
                description: Translation.tr("Puts every tiling option back, including these.")
            }
        }
    }
        }
    }

    SettingsTaskLoader {
        requested: root.activeSection === "apps"
        sourceComponent: Component {
    SettingsCardSection {
        settingsTaskSection: "apps"
        expanded: true
        icon: "apps"
        title: Translation.tr("Apps")

        SettingsGroup {
            ContentSubsection {
                title: Translation.tr("Only tile these apps")
                StyledText {
                    Layout.fillWidth: true
                    text: Translation.tr("Empty = tile every window. Add an app's window class (for example kitty, org.kde.dolphin, firefox) to tile only those. The class is the app id KDE shows in System Settings › Window Rules.")
                    color: Appearance.colors.colSubtext
                    font.pixelSize: Appearance.font.pixelSize.smaller
                    wrapMode: Text.WordWrap
                }
                Flow {
                    Layout.fillWidth: true
                    spacing: 6
                    visible: (Config.options?.tiling?.onlyClasses ?? []).length > 0
                    Repeater {
                        model: Array.from(Config.options?.tiling?.onlyClasses ?? [])
                        InputChip {
                            required property string modelData
                            text: modelData
                            monospace: true
                            onRemoved: root.listRemove("onlyClasses", modelData)
                        }
                    }
                }
                MaterialTextField {
                    Layout.fillWidth: true
                    placeholderText: Translation.tr("Add a window class, then press Enter")
                    font.pixelSize: Appearance.font.pixelSize.small
                    onAccepted: { root.listAdd("onlyClasses", text); text = "" }
                }
            }

            ContentSubsection {
                title: Translation.tr("Never tile these apps")
                StyledText {
                    Layout.fillWidth: true
                    text: Translation.tr("These always float. A trailing * matches a prefix (steam_app_* covers every Steam game). Dialogs, pop-ups and fixed-size windows always float on their own. Meta+Alt+V floats or re-tiles the focused window.")
                    color: Appearance.colors.colSubtext
                    font.pixelSize: Appearance.font.pixelSize.smaller
                    wrapMode: Text.WordWrap
                }
                Flow {
                    Layout.fillWidth: true
                    spacing: 6
                    Repeater {
                        model: Array.from(Config.options?.tiling?.floatClasses ?? [])
                        InputChip {
                            required property string modelData
                            text: modelData
                            monospace: true
                            onRemoved: root.listRemove("floatClasses", modelData)
                        }
                    }
                }
                MaterialTextField {
                    Layout.fillWidth: true
                    placeholderText: Translation.tr("Add a window class, then press Enter")
                    font.pixelSize: Appearance.font.pixelSize.small
                    onAccepted: { root.listAdd("floatClasses", text); text = "" }
                }
            }
        }
    }
        }
    }

    SettingsTaskLoader {
        requested: root.activeSection === "keys"
        sourceComponent: Component {
    SettingsCardSection {
        settingsTaskSection: "keys"
        expanded: true
        icon: "keyboard"
        title: Translation.tr("Keys")

        SettingsGroup {
            ConfigSwitch {
                Layout.fillWidth: true
                buttonIcon: "keyboard_arrow_right"
                text: Translation.tr("Meta + arrow keys belong to the tiler")
                checked: Config.options?.tiling?.takeOverQuickTile ?? true
                onCheckedChanged: Config.setNestedValue("tiling.takeOverQuickTile", checked)
                StyledToolTip { text: Translation.tr("While tiling runs, KDE's quick-tile keys (Meta + arrows) are released and used by the tiler; they are given back when tiling stops or this is switched off. Floating windows still get KDE's quick tile. REVERT-tiling-quicktile.sh in ~/.local/share/Fancy-Floating-Bar restores them if the bar ever dies mid-run.") }
            }

            ConfigSwitch {
                Layout.fillWidth: true
                buttonIcon: "view_column"
                text: Translation.tr("Meta + arrows also move columns on scrolling monitors")
                checked: Config.options?.tiling?.arrowKeysScrollStrips ?? false
                onCheckedChanged: Config.setNestedValue("tiling.arrowKeysScrollStrips", checked)
                StyledToolTip { text: Translation.tr("Off (default): on a scrolling monitor Meta + arrows do nothing to tiled windows. On a monitor with fixed regions they always move the window between regions, and never across monitors (Meta+Shift+arrows is KDE's move-to-screen).") }
            }

            ContentSubsection {
                title: Translation.tr("Tiling shortcuts (only while tiling is on)")
                Repeater {
                    model: [
                        { keys: "Meta+Alt+H / L", what: Translation.tr("Focus left / right (also Ctrl + Alt + ← →)") },
                        { keys: "Meta+Alt+J / K", what: Translation.tr("Focus down / up (also Ctrl + Alt + ↓ ↑)") },
                        { keys: "Meta+Alt+Shift+H / L", what: Translation.tr("Move the window left / right") },
                        { keys: "Meta+Alt+Shift+J / K", what: Translation.tr("Move the window down / up") },
                        { keys: "Meta+Alt+[ / ]", what: Translation.tr("Pull the window into the previous / next column, or push it out into its own") },
                        { keys: "Meta+Alt+R", what: Translation.tr("Cycle the column width (the height of a row on a portrait monitor)") },
                        { keys: "Meta+Alt+F", what: Translation.tr("Maximize the column") },
                        { keys: "Meta+Alt+C", what: Translation.tr("Center the column") },
                        { keys: "Meta+Alt+V", what: Translation.tr("Float / re-tile the window") },
                        { keys: "Meta + ← → ↑ ↓", what: Translation.tr("Regions mode: move the window to the neighbouring region that way (within the monitor). Scrolling monitors: nothing, unless enabled above") },
                        { keys: "Ctrl+Meta+S", what: Translation.tr("Regions mode: split the focused region into a top and a bottom half, or merge it back") },
                        { keys: "Meta+Alt+G", what: Translation.tr("Switch this monitor between scrolling columns and fixed regions") },
                        { keys: "Meta+Alt+1 … 6", what: Translation.tr("Regions mode: send the window to region 1 … 6") }
                    ]
                    RowLayout {
                        required property var modelData
                        Layout.fillWidth: true
                        spacing: 12
                        StyledText {
                            Layout.preferredWidth: 220
                            text: modelData.keys
                            font.family: Appearance.font.family.monospace
                            font.pixelSize: Appearance.font.pixelSize.small
                            color: Appearance.colors.colPrimary
                        }
                        StyledText {
                            Layout.fillWidth: true
                            text: modelData.what
                            font.pixelSize: Appearance.font.pixelSize.small
                            color: Appearance.colors.colOnLayer1
                            wrapMode: Text.WordWrap
                        }
                    }
                }
                StyledText {
                    Layout.fillWidth: true
                    text: Translation.tr("On a portrait monitor up / down walk the rows and left / right move between windows side by side in a row. Drag a border to resize (the neighbour gives way); drag a window by its title bar to reorder it or move it to another monitor. Meta+Alt+K and L used to switch keyboard layouts and Meta+Alt+R recorded the screen; those bindings were released for the tiler (REVERT-tiling-keys.sh in ~/.local/share/Fancy-Floating-Bar gives them back). The full list is in TILING_CHEATSHEET.md.")
                    color: Appearance.colors.colSubtext
                    font.pixelSize: Appearance.font.pixelSize.smaller
                    wrapMode: Text.WordWrap
                }
            }
        }
    }
        }
    }
}
