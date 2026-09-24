import qs
import qs.services
import qs.modules.common
import qs.modules.common.widgets
import qs.modules.common.functions
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

/**
 * KWin port: iNiR's BarModuleOrderEditor, adapted to the pill's hover row
 * (bar.pill.rowOrder). The drag/drop interaction and visuals are upstream's,
 * unchanged; only the data layer, the eye toggle and the header differ, and
 * the "available" tray is gone (pill items are always placed).
 *
 * Upstream description:
 * Drag-and-drop per-zone bar layout editor.
 *
 * Five zones (left, centerLeft, center, centerRight, right) each render their
 * module rows inside a soft container card with a DropArea. Rows are draggable
 * across zones AND from the "Available" chip tray; uniform row height makes the
 * insert-index a simple `round(y / pitch)`. The dragged row reparents into
 * `dragLayer` (top z) and follows the cursor; a primary-coloured bar marks the
 * drop slot. Writes go through Config per-leaf (never assign a whole object to
 * the bar.layout JsonObject). Every module follows the same relocation contract;
 * `center` is the screen-centred zone, not a hard-coded workspace pivot. Modules
 * not in any zone appear as compact chips that can be either dragged into a zone
 * or added via a single popup menu trigger.
 */
ColumnLayout {
    id: root
    Layout.fillWidth: true
    spacing: 12

    readonly property int rowH: 36
    readonly property int rowGap: 4
    readonly property real pitch: rowH + rowGap
    readonly property string availableZone: "__available__"

    // ─── Pill data layer (KWin port) ────────────────────────────────────
    // Zones are the pill's hover-row groups (split by "|" in bar.pill.rowOrder).
    // Every item is always placed — the pill appends anything a list leaves
    // out — so there is no "available" tray and no remove; the eye button is
    // the item's existing bar.pill.modules / surfaces switch.
    readonly property var _defaultOrder: ["weather", "tray", "wifi", "battery", "inbox", "|",
        "media", "launcher", "glance", "mixer", "clipboard", "recorder", "sysmon", "|",
        "settings", "sidebarLeft", "sidebarRight", "power"]
    readonly property var _knownIds: _defaultOrder.filter(id => id !== "|")
    readonly property int _maxGroups: 5   // the pill has 4 dividers
    readonly property var _groups: {
        let order = []
        try { order = Array.from(Config.options?.bar?.pill?.rowOrder ?? []).map(String) } catch (e) {}
        if (order.length === 0) order = root._defaultOrder
        const groups = [[]], seen = new Set()
        for (const id of order) {
            if (id === "|") { if (groups.length < root._maxGroups) groups.push([]); continue }
            if (!root._knownIds.includes(id) || seen.has(id)) continue
            seen.add(id); groups[groups.length - 1].push(id)
        }
        for (const id of root._knownIds) if (!seen.has(id)) groups[groups.length - 1].push(id)
        return groups.filter((g, k) => g.length > 0 || k === 0)
    }
    // Existing groups plus one empty zone to start a new group in.
    readonly property var _zones: {
        const z = []
        for (let k = 0; k < Math.min(root._groups.length + 1, root._maxGroups); k++) z.push("g" + k)
        return z
    }
    function _zoneIndex(z) { return parseInt(String(z).slice(1)) }
    function _getZone(name) { return (root._groups[root._zoneIndex(name)] ?? []).slice() }
    function _write(groups) {
        const out = []
        groups.filter(g => g.length > 0).forEach((g, k) => { if (k > 0) out.push("|"); out.push(...g) })
        Config.setNestedValue("bar.pill.rowOrder", out)
    }
    function _resetToDefaults() { Config.resetPath("bar.pill.rowOrder", "baseline") }

    function _metaIcon(id) {
        return ({ weather: "partly_cloudy_day", tray: "shelf_auto_hide", wifi: "wifi", battery: "battery_full",
            inbox: "notifications", media: "music_note", launcher: "apps", glance: "calendar_month",
            mixer: "equalizer", clipboard: "content_paste", recorder: "screen_record", sysmon: "monitor_heart",
            settings: "settings", sidebarLeft: "left_panel_open", sidebarRight: "right_panel_open",
            power: "power_settings_new" })[id] || "widgets"
    }
    function _metaLabel(id) {
        return ({ weather: Translation.tr("Weather"), tray: Translation.tr("System tray"), wifi: Translation.tr("Wi-Fi"),
            battery: Translation.tr("Battery"), inbox: Translation.tr("Notifications"), media: Translation.tr("Media (while playing)"),
            launcher: Translation.tr("App search"), glance: Translation.tr("Glance"), mixer: Translation.tr("Mixer"),
            clipboard: Translation.tr("Clipboard"), recorder: Translation.tr("Recorder"), sysmon: Translation.tr("System monitor"),
            settings: Translation.tr("Settings"), sidebarLeft: Translation.tr("Left sidebar"),
            sidebarRight: Translation.tr("Right sidebar"), power: Translation.tr("Power") })[id] || id
    }
    function _zoneLabel(z) {
        const k = root._zoneIndex(z)
        return k >= root._groups.length ? Translation.tr("New group") : Translation.tr("Group %1").arg(k + 1)
    }
    function _zoneIcon(z) { return root._zoneIndex(z) >= root._groups.length ? "add" : "view_column" }

    // Show/hide: the pill's own switches (both sidebar buttons share one).
    function _visPath(id) {
        if (["weather", "tray", "wifi", "battery", "inbox", "mixer", "power"].includes(id)) return "modules." + id
        if (id === "sidebarLeft" || id === "sidebarRight") return "modules.sidebars"
        if (["launcher", "glance", "clipboard", "recorder", "sysmon"].includes(id)) return "surfaces." + id
        return ""
    }
    function _visGet(id) {
        const p = root._visPath(id).split(".")
        return p.length === 2 ? (Config.options?.bar?.pill?.[p[0]]?.[p[1]] ?? (id !== "recorder")) : true
    }
    function _visSet(id, v) { const p = root._visPath(id); if (p.length) Config.setNestedValue("bar.pill." + p, v) }

    // Move from (srcZone, srcIdx) to dstZone at dstIdx: one write of rowOrder.
    function _dropMove(srcZone, srcIdx, srcId, dstZone, dstIdx) {
        const groups = root._groups.map(g => g.slice())
        const si = root._zoneIndex(srcZone), di = root._zoneIndex(dstZone)
        while (groups.length <= di) groups.push([])
        const [m] = groups[si].splice(srcIdx, 1)
        groups[di].splice(Math.max(0, Math.min(dstIdx, groups[di].length)), 0, m)
        root._write(groups)
    }

    // ─── Drag state ─────────────────────────────────────────────────────
    property var dragInfo: null      // { zone, index, id } of the row being dragged
    property string dropZone: ""     // zone currently hovered
    property int dropIndex: -1       // insert slot in dropZone
    readonly property bool dragging: dragInfo !== null
    function _indexFromY(y, count) { return Math.max(0, Math.min(Math.round(y / root.pitch), count)) }
    function _commitDrop(dstZone) {
        if (root.dragInfo && root.dropIndex >= 0)
            root._dropMove(root.dragInfo.zone, root.dragInfo.index, root.dragInfo.id, dstZone, root.dropIndex)
        root._endDrag()
    }
    function _endDrag() { root.dragInfo = null; root.dropZone = ""; root.dropIndex = -1 }

    // Floating layer the dragged row reparents into so it can follow the cursor
    // above every zone. Sits in a sibling overlay (not the layout flow) so its
    // anchors don't fight the ColumnLayout.
    Item {
        Layout.fillWidth: true
        Layout.preferredHeight: 0
        z: 100
        clip: false
        Item { id: dragLayer; width: root.width; height: root.height }
    }

    // ─── Header ─────────────────────────────────────────────────────────
    RowLayout {
        Layout.fillWidth: true
        spacing: 8
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 2
            StyledText {
                Layout.fillWidth: true
                text: Translation.tr("Drag items to reorder the hover row. Groups are separated by a hairline; drop into New group to start another.")
                color: Appearance.colors.colSubtext
                font.pixelSize: Appearance.font.pixelSize.smaller
                wrapMode: Text.WordWrap
            }
            StyledText {
                Layout.fillWidth: true
                text: Translation.tr("The eye hides an item without moving it. Changes apply live.")
                color: Appearance.colors.colSubtext
                font.pixelSize: Appearance.font.pixelSize.smaller
                opacity: 0.7
                wrapMode: Text.WordWrap
            }
        }
        RippleButton {
            implicitWidth: 30; implicitHeight: 30
            buttonRadius: Appearance.editorialEverywhere ? Appearance.rounding.small : Appearance.rounding.full
            onClicked: root._resetToDefaults()
            contentItem: MaterialSymbol { anchors.centerIn: parent; text: "restart_alt"; iconSize: Appearance.font.pixelSize.small; color: Appearance.colors.colOnLayer1 }
            StyledToolTip { text: Translation.tr("Reset row order to your defaults") }
        }
    }

    // ─── Draggable row (reused) ─────────────────────────────────────────
    component ModuleRow: Rectangle {
        id: rowRoot
        property string moduleId: ""
        property string zone: ""
        property int rowIndex: -1
        // Taskbar is a mode of the activeWindow slot, not an independent
        // visibility bit. While that mode is active, hiding `activeWindow`
        // would only mutate latent state and leave the visible taskbar intact.
        property string visibilityKey: root._visPath(moduleId)
        readonly property bool beingDragged: root.dragInfo && root.dragInfo.id === moduleId && root.dragInfo.zone === zone && root.dragInfo.index === rowIndex

        width: parent ? parent.width : implicitWidth
        height: root.rowH
        radius: Appearance.rounding.small
        color: beingDragged ? Appearance.colors.colLayer2
            : (dragMa.containsMouse ? Appearance.colors.colLayer1Hover : Appearance.colors.colLayer1)
        border.color: beingDragged ? Appearance.colors.colPrimary : Appearance.colors.colOutlineVariant
        border.width: 1
        scale: beingDragged ? 1.03 : 1
        rotation: beingDragged ? 0.6 : 0
        Behavior on scale { enabled: Appearance.animationsEnabled; NumberAnimation { duration: 120; easing.type: Easing.OutCubic } }
        Behavior on rotation { enabled: Appearance.animationsEnabled; NumberAnimation { duration: 120; easing.type: Easing.OutCubic } }
        Behavior on color { enabled: Appearance.animationsEnabled; ColorAnimation { duration: Appearance.animation.elementMoveFast.duration } }

        // Lift shadow while floating over the zones
        StyledRectangularShadow {
            target: rowRoot.beingDragged ? rowRoot : null
            visible: rowRoot.beingDragged
            z: -1
        }

        readonly property color _fg: Appearance.colors.colOnLayer1
        readonly property color _fgSubtle: Appearance.colors.colSubtext

        // Drag plumbing — reparent into dragLayer while dragging so the row can
        // travel over other zones; Drag.drop() fires the hovered DropArea.
        Drag.active: dragMa.drag.active
        Drag.source: rowRoot
        Drag.hotSpot.x: width / 2
        Drag.hotSpot.y: height / 2
        states: State {
            when: dragMa.drag.active
            ParentChange { target: rowRoot; parent: dragLayer }
            PropertyChanges { rowRoot { z: 200 } }
        }

        MouseArea {
            id: dragMa
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: drag.active ? Qt.ClosedHandCursor : Qt.OpenHandCursor
            drag.target: rowRoot
            drag.axis: Drag.XAndYAxis
            onPressed: root.dragInfo = { zone: rowRoot.zone, index: rowRoot.rowIndex, id: rowRoot.moduleId }
            onReleased: {
                if (rowRoot.Drag.target) rowRoot.Drag.drop()
                else root._endDrag()
            }
            onCanceled: root._endDrag()
        }

        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 8
            anchors.rightMargin: 6
            spacing: 8
            MaterialSymbol {
                text: "drag_indicator"
                iconSize: Appearance.font.pixelSize.normal
                color: rowRoot._fgSubtle
            }
            MaterialSymbol { text: root._metaIcon(rowRoot.moduleId); iconSize: Appearance.font.pixelSize.normal; color: rowRoot._fg }
            StyledText {
                Layout.fillWidth: true
                text: root._metaLabel(rowRoot.moduleId)
                font.pixelSize: Appearance.font.pixelSize.smaller
                color: rowRoot._fg
                elide: Text.ElideRight
            }
            // Visibility toggle (modules that have a bar.modules.<key> switch)
            RippleButton {
                visible: rowRoot.visibilityKey.length > 0
                implicitWidth: 26; implicitHeight: 26
                buttonRadius: Appearance.editorialEverywhere ? Appearance.rounding.small : Appearance.rounding.full
                onClicked: root._visSet(rowRoot.moduleId, !root._visGet(rowRoot.moduleId))
                contentItem: MaterialSymbol {
                    anchors.centerIn: parent
                    text: root._visGet(rowRoot.moduleId) ? "visibility" : "visibility_off"
                    iconSize: Appearance.font.pixelSize.small
                    color: root._visGet(rowRoot.moduleId) ? rowRoot._fg : rowRoot._fgSubtle
                }
                StyledToolTip {
                    text: root._visGet(rowRoot.moduleId)
                        ? Translation.tr("Hide from the pill (keeps its place)") : Translation.tr("Show in the pill")
                }
            }
        }
    }

    // ─── Zones ──────────────────────────────────────────────────────────
    Repeater {
        model: root._zones
        delegate: Rectangle {
            id: zoneCard
            required property string modelData
            required property int index
            readonly property string zoneName: modelData
            readonly property var zoneItems: root._getZone(zoneName)
            readonly property bool dropActive: root.dragging && root.dropZone === zoneName

            Layout.fillWidth: true
            implicitHeight: zoneInner.implicitHeight + 16
            radius: Appearance.rounding.normal
            color: dropActive ? ColorUtils.transparentize(Appearance.colors.colPrimary, 0.92)
                : Appearance.colors.colLayer0
            border.color: dropActive ? Appearance.colors.colPrimary : Appearance.colors.colOutlineVariant
            border.width: 1
            Behavior on color { enabled: Appearance.animationsEnabled; ColorAnimation { duration: Appearance.animation.elementMoveFast.duration } }
            Behavior on border.color { enabled: Appearance.animationsEnabled; ColorAnimation { duration: Appearance.animation.elementMoveFast.duration } }

            ColumnLayout {
                id: zoneInner
                anchors.fill: parent
                anchors.margins: 8
                spacing: 6

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Rectangle {
                        implicitWidth: 24; implicitHeight: 24
                        radius: Appearance.editorialEverywhere ? Appearance.rounding.small : Appearance.rounding.full
                        color: ColorUtils.transparentize(Appearance.colors.colPrimary, 0.85)
                        MaterialSymbol { anchors.centerIn: parent; text: root._zoneIcon(zoneCard.zoneName); iconSize: Appearance.font.pixelSize.small; color: Appearance.colors.colPrimary }
                    }
                    StyledText {
                        Layout.fillWidth: true
                        text: root._zoneLabel(zoneCard.zoneName)
                        font.pixelSize: Appearance.font.pixelSize.small
                        font.weight: Appearance.editorialEverywhere ? Appearance.editorial.titleWeight : Font.DemiBold
                        color: Appearance.colors.colOnLayer0
                    }
                    Rectangle {
                        implicitHeight: 18
                        implicitWidth: Math.max(22, countLabel.implicitWidth + 12)
                        radius: Appearance.editorialEverywhere ? Appearance.rounding.small : Appearance.rounding.full
                        color: ColorUtils.transparentize(Appearance.colors.colOnLayer1, 0.92)
                        StyledText {
                            id: countLabel
                            anchors.centerIn: parent
                            text: zoneCard.zoneItems.length + ""
                            font.pixelSize: Appearance.font.pixelSize.smaller
                            color: Appearance.colors.colSubtext
                        }
                    }
                }

                DropArea {
                    id: zoneDrop
                    Layout.fillWidth: true
                    implicitHeight: Math.max(rowCol.implicitHeight, root.rowH)
                    readonly property string zoneName: zoneCard.zoneName
                    // Live count of rows actually laid out in this zone's Column
                    // (excludes the row currently lifted out of THIS zone).
                    readonly property int liveCount: zoneCard.zoneItems.length
                        - ((root.dragInfo && root.dragInfo.zone === zoneName) ? 1 : 0)
                    function _update(y) {
                        root.dropZone = zoneName
                        root.dropIndex = root._indexFromY(y, zoneDrop.liveCount)
                    }
                    onEntered: drag => zoneDrop._update(drag.y)
                    onPositionChanged: drag => zoneDrop._update(drag.y)
                    onExited: if (root.dropZone === zoneName) { root.dropZone = ""; root.dropIndex = -1 }
                    onDropped: root._commitDrop(zoneName)

                    Rectangle {
                        visible: zoneDrop.liveCount === 0
                        anchors.fill: parent
                        radius: Appearance.rounding.small
                        color: zoneCard.dropActive ? ColorUtils.transparentize(Appearance.colors.colPrimary, 0.9) : "transparent"
                        border.color: zoneCard.dropActive ? Appearance.colors.colPrimary : Appearance.colors.colOutlineVariant
                        border.width: 1
                        Behavior on color { enabled: Appearance.animationsEnabled; ColorAnimation { duration: Appearance.animation.elementMoveFast.duration } }
                        RowLayout {
                            anchors.centerIn: parent
                            spacing: 6
                            MaterialSymbol {
                                text: zoneCard.dropActive ? "download" : "drag_handle"
                                iconSize: Appearance.font.pixelSize.normal
                                color: zoneCard.dropActive ? Appearance.colors.colPrimary : Appearance.colors.colSubtext
                            }
                            StyledText {
                                text: zoneCard.dropActive ? Translation.tr("Release to drop") : Translation.tr("Drop items here")
                                font.pixelSize: Appearance.font.pixelSize.smaller
                                color: zoneCard.dropActive ? Appearance.colors.colPrimary : Appearance.colors.colSubtext
                            }
                        }
                    }

                    Column {
                        id: rowCol
                        width: parent.width
                        spacing: root.rowGap
                        Repeater {
                            model: zoneCard.zoneItems
                            delegate: ModuleRow {
                                required property string modelData
                                required property int index
                                moduleId: modelData
                                zone: zoneCard.zoneName
                                rowIndex: index
                            }
                        }
                        // Reserve the lifted row's height so the Column (and the
                        // drop-slot math, which is y/pitch) stays stable while a
                        // row from THIS zone is floating in dragLayer. Without
                        // this the Column collapses by one pitch mid-drag and the
                        // computed insert index jumps.
                        Item {
                            visible: root.dragInfo && root.dragInfo.zone === zoneDrop.zoneName
                            width: parent.width
                            height: visible ? root.rowH : 0
                        }
                    }

                    // Drop slot indicator — animates between insert positions.
                    Rectangle {
                        id: dropSlot
                        visible: zoneCard.dropActive && root.dropIndex >= 0 && zoneDrop.liveCount > 0
                        x: 6
                        width: parent.width - 12
                        height: 4
                        radius: 2
                        color: Appearance.colors.colPrimary
                        y: Math.min(root.dropIndex, zoneDrop.liveCount) * root.pitch - root.rowGap / 2 - height / 2
                        z: 50
                        Behavior on y {
                            enabled: Appearance.animationsEnabled
                            NumberAnimation { duration: Appearance.animation.elementMoveFast.duration; easing.type: Appearance.animation.elementMoveFast.type; easing.bezierCurve: Appearance.animation.elementMoveFast.bezierCurve }
                        }
                        // End caps make the insert slot read as a slot, not a divider
                        Rectangle { width: 8; height: 8; radius: 4; color: parent.color; anchors.verticalCenter: parent.verticalCenter; x: -4 }
                        Rectangle { width: 8; height: 8; radius: 4; color: parent.color; anchors.verticalCenter: parent.verticalCenter; x: parent.width - 4 }
                    }
                }
            }
        }
    }
}
