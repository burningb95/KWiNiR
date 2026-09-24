pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import qs.modules.common
import qs.modules.common.widgets
import qs.modules.common.functions
import qs.services
import "root:"

Item {
    id: root
    implicitHeight: column.implicitHeight

    property bool animateIn: false

    // Exposed so WidgetsView / SwipeView can block swiping early
    property bool dragPending: false

    property var widgetOrder: {
        const saved = Config.options?.sidebar?.widgets?.widgetOrder
        if (!saved) return defaultOrder
        const missing = defaultOrder.filter(id => !saved.includes(id))
        return [...saved, ...missing]
    }
    readonly property var defaultOrder: ["media", "week", "context", "note", "launch", "controls", "status", "crypto", "wallpaper", "worldclock"]
    readonly property int widgetSpacing: Config.options?.sidebar?.widgets?.spacing ?? 8

    readonly property bool showMedia: Config.options?.sidebar?.widgets?.media ?? true
    readonly property bool showWeek: Config.options?.sidebar?.widgets?.week ?? true
    readonly property bool showContext: Config.options?.sidebar?.widgets?.context ?? true
    readonly property bool showNote: Config.options?.sidebar?.widgets?.note ?? true
    readonly property bool showLaunch: Config.options?.sidebar?.widgets?.launch ?? true
    readonly property bool showControls: Config.options?.sidebar?.widgets?.controls ?? true
    readonly property bool showStatus: Config.options?.sidebar?.widgets?.status ?? true
    readonly property bool showCrypto: Config.options?.sidebar?.widgets?.crypto ?? false
    readonly property bool showWallpaper: Config.options?.sidebar?.widgets?.wallpaper ?? false
    readonly property bool showWorldClock: Config.options?.sidebar?.widgets?.worldClock ?? true

    // ─── KWin port: per-item sizes and blank spacers ─────────────────────
    // sidebar.widgets.itemSizes: "id=normal|tall|fill"; sidebar.widgets.spacers:
    // "spacer-N=<px>" (spacers are placed through widgetOrder like any item).
    // tall = 1.5x natural height; fill = shares whatever height the tab has left
    // (never less than natural; if nothing is left the tab just scrolls as before).
    function _parsePairs(list): var {
        const out = ({})
        for (const entry of Array.from(list ?? [])) {
            const s = String(entry), i = s.indexOf("=")
            if (i > 0) out[s.slice(0, i)] = s.slice(i + 1)
        }
        return out
    }
    readonly property var sizeMap: _parsePairs(Config.options?.sidebar?.widgets?.itemSizes)
    readonly property var spacerMap: {
        const raw = _parsePairs(Config.options?.sidebar?.widgets?.spacers)
        const out = ({})
        for (const id in raw) {
            const px = Number(raw[id])
            if (id.startsWith("spacer-") && px > 0) out[id] = Math.min(600, px)
        }
        return out
    }
    // ─── KWin port: in-sidebar layout editing ("Edit" button) ─────────────
    // arranging: persistent edit mode — hide (✕), cycle size, drag from anywhere,
    // add hidden items/spacers from a tray. Writes the same config as Settings.
    property bool arranging: false
    readonly property var itemLabels: ({
        media: Translation.tr("Media player"), week: Translation.tr("Week strip"),
        context: Translation.tr("Weather"), note: Translation.tr("Quick note"),
        launch: Translation.tr("Quick launch"), controls: Translation.tr("Controls"),
        status: Translation.tr("Status rings"), crypto: Translation.tr("Crypto"),
        wallpaper: Translation.tr("Wallpapers"), worldclock: Translation.tr("World clock")
    })
    readonly property var itemIcons: ({
        media: "music_note", week: "calendar_view_week", context: "partly_cloudy_day",
        note: "edit_note", launch: "rocket_launch", controls: "tune", status: "monitoring",
        crypto: "currency_bitcoin", wallpaper: "wallpaper", worldclock: "public"
    })
    readonly property var flagKeys: ({
        media: "media", week: "week", context: "context", note: "note", launch: "launch",
        controls: "controls", status: "status", crypto: "crypto", wallpaper: "wallpaper",
        worldclock: "worldClock"
    })
    readonly property var hiddenItems: Object.keys(root.flagKeys).filter(id => !root.visibleWidgets.includes(id))

    function setShown(id: string, shown: bool): void {
        Config.setNestedValue("sidebar.widgets." + root.flagKeys[id], shown)
        if (shown) {
            const order = Array.from(Config.options?.sidebar?.widgets?.widgetOrder ?? [])
            if (!order.includes(id)) Config.setNestedValue("sidebar.widgets.widgetOrder", order.concat([id]))
        }
    }
    function _spacerPairs(): var {
        return Array.from(Config.options?.sidebar?.widgets?.spacers ?? []).map(String).filter(e => e.indexOf("=") > 0)
    }
    function addSpacer(): void {
        const pairs = root._spacerPairs()
        let n = 1
        while (pairs.some(e => e.startsWith("spacer-" + n + "="))) n++
        const id = "spacer-" + n
        Config.setNestedValue("sidebar.widgets.spacers", pairs.concat([id + "=24"]))
        const order = Array.from(Config.options?.sidebar?.widgets?.widgetOrder ?? [])
        if (!order.includes(id)) Config.setNestedValue("sidebar.widgets.widgetOrder", order.concat([id]))
    }
    function removeItem(id: string): void {
        if (id.startsWith("spacer-")) {
            Config.setNestedValue("sidebar.widgets.spacers", root._spacerPairs().filter(e => !e.startsWith(id + "=")))
            Config.setNestedValue("sidebar.widgets.widgetOrder",
                Array.from(Config.options?.sidebar?.widgets?.widgetOrder ?? []).filter(x => x !== id))
        } else {
            root.setShown(id, false)
        }
    }
    function cycleSize(id: string): void {
        const next = ({ normal: "tall", tall: "fill", fill: "normal" })[root.sizeMap[id] ?? "normal"] ?? "normal"
        const rest = Array.from(Config.options?.sidebar?.widgets?.itemSizes ?? []).map(String)
            .filter(e => !e.startsWith(id + "="))
        Config.setNestedValue("sidebar.widgets.itemSizes", next === "normal" ? rest : rest.concat([id + "=" + next]))
    }

    // Height the item column may use (set by WidgetsView); <= 0 disables fill.
    property real availableHeight: -1
    readonly property real fillShare: {
        if (root.availableHeight <= 0) return 0
        let fixed = 0, fills = 0, shown = 0
        for (let i = 0; i < repeater.count; i++) {
            const it = repeater.itemAt(i)
            if (!it || it.naturalHeight <= 0) continue
            shown++
            fixed += it.editPad
            if (it.sizeMode === "fill") fills++
            else fixed += it.fixedHeight
        }
        if (fills === 0) return 0
        // leave room for the Edit button (and the Add tray while arranging)
        const footer = editButton.height + editButton.Layout.topMargin + root.widgetSpacing
            + (addTray.visible ? addTray.height + addTray.Layout.topMargin + root.widgetSpacing : 0)
        return Math.max(0, (root.availableHeight - fixed - Math.max(0, shown - 1) * root.widgetSpacing - footer) / fills)
    }

    readonly property var visibleWidgets: {
        const order = widgetOrder ?? defaultOrder
        return order.filter(id => {
            switch (id) {
            case "media": return showMedia
            case "week": return showWeek
            case "context": return showContext
            case "note": return showNote
            case "launch": return showLaunch
            case "controls": return showControls
            case "status": return showStatus
            case "crypto": return showCrypto
            case "wallpaper": return showWallpaper
            case "worldclock": return showWorldClock
            default: return String(id).startsWith("spacer-") && (id in root.spacerMap)
            }
        })
    }

    // ─── Drag state ──────────────────────────────────────────────────────
    property int dragIndex: -1
    property int hoverIndex: -1
    property bool editMode: false
    property real dragStartY: 0
    property real dragCurrentY: 0
    property var _itemHeights: []

    function _cacheItemHeights(): void {
        const heights = []
        for (let i = 0; i < repeater.count; i++) {
            const item = repeater.itemAt(i)
            heights.push(item && item.visible ? item.height : 0)
        }
        _itemHeights = heights
    }

    function getDisplacementY(itemIndex: int): real {
        if (!editMode || dragIndex < 0 || hoverIndex < 0) return 0
        if (itemIndex === dragIndex) return 0

        if (dragIndex < hoverIndex) {
            if (itemIndex > dragIndex && itemIndex <= hoverIndex) {
                const h = _itemHeights[dragIndex] ?? 0
                return -(h + column.spacing)
            }
        } else if (dragIndex > hoverIndex) {
            if (itemIndex >= hoverIndex && itemIndex < dragIndex) {
                const h = _itemHeights[dragIndex] ?? 0
                return h + column.spacing
            }
        }
        return 0
    }

    // Pixel offset the dragged widget should move to follow the cursor
    function getDragFollowY(): real {
        if (!editMode || dragIndex < 0) return 0
        return dragCurrentY - dragStartY
    }

    function moveWidget(fromIdx: int, toIdx: int): void {
        if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return
        const fromId = visibleWidgets[fromIdx]
        const toId = visibleWidgets[toIdx]

        let newOrder = [...(widgetOrder ?? defaultOrder)]
        const realFrom = newOrder.indexOf(fromId)
        const realTo = newOrder.indexOf(toId)

        newOrder.splice(realFrom, 1)
        newOrder.splice(realTo, 0, fromId)

        Config.setNestedValue("sidebar.widgets.widgetOrder", newOrder)
    }

    function startDrag(index: int, mouseY: real): void {
        _cacheItemHeights()
        dragIndex = index
        hoverIndex = index
        dragStartY = mouseY
        dragCurrentY = mouseY
        editMode = true
        dragPending = false // Now fully in drag mode
    }

    function updateDrag(mouseY: real): void {
        if (dragIndex < 0) return
        dragCurrentY = mouseY

        let accY = 0
        for (let i = 0; i < repeater.count; i++) {
            const item = repeater.itemAt(i)
            if (!item || !item.visible) continue
            const itemCenter = accY + item.height / 2
            if (mouseY < itemCenter) {
                hoverIndex = i
                return
            }
            accY += item.height + column.spacing
        }
        hoverIndex = repeater.count - 1
    }

    function endDrag(): void {
        if (dragIndex >= 0 && hoverIndex >= 0 && dragIndex !== hoverIndex) {
            moveWidget(dragIndex, hoverIndex)
        }
        _resetDrag()
    }

    function cancelDrag(): void {
        _resetDrag()
    }

    function _resetDrag(): void {
        dragIndex = -1
        hoverIndex = -1
        editMode = false
        dragPending = false
        dragStartY = 0
        dragCurrentY = 0
        _itemHeights = []
    }

    Connections {
        target: GlobalStates
        function onSidebarLeftOpenChanged() {
            if (!GlobalStates.sidebarLeftOpen) {
                root.cancelDrag()
                root.arranging = false
            }
        }
    }

    // Engineering dot grid while reordering — same edit-space language as the
    // desktop widget edit mode.
    DotGridCanvas {
        anchors.fill: parent
        gridSize: 24
        visible: opacity > 0
        opacity: root.editMode ? 1 : 0
        Behavior on opacity {
            enabled: Appearance.animationsEnabled
            NumberAnimation { duration: Appearance.animation.elementMoveFast.duration; easing.type: Appearance.animation.elementMoveFast.type; easing.bezierCurve: Appearance.animation.elementMoveFast.bezierCurve }
        }
    }

    ColumnLayout {
        id: column
        width: parent.width
        spacing: root.widgetSpacing

        Repeater {
            id: repeater
            model: root.visibleWidgets

            delegate: Item {
                id: widgetWrapper
                required property string modelData
                required property int index

                Layout.fillWidth: true
                // KWin port: size from sidebar.widgets.itemSizes / spacers (see top of file)
                readonly property bool isSpacer: modelData.startsWith("spacer-")
                readonly property string sizeMode: isSpacer ? "normal" : (root.sizeMap[modelData] ?? "normal")
                // While arranging, enabled items with nothing to show (media with no player)
                // get a labelled placeholder so they can still be moved or removed.
                readonly property bool placeholder: root.arranging && !isSpacer && (contentLoader.item?.implicitHeight ?? 0) <= 0
                readonly property real naturalHeight: isSpacer ? (root.spacerMap[modelData] ?? 0)
                    : placeholder ? 40 : (contentLoader.item?.implicitHeight ?? 0)
                readonly property real fixedHeight: sizeMode === "tall" ? Math.round(naturalHeight * 1.5) : naturalHeight
                // While arranging, a strip above each item holds its controls so they never cover content.
                readonly property real editPad: root.arranging ? 28 : 0
                readonly property real slotHeight: naturalHeight <= 0 ? 0
                    : sizeMode === "fill" ? Math.max(naturalHeight, Math.floor(root.fillShare))
                    : fixedHeight
                Layout.preferredHeight: slotHeight <= 0 ? 0 : slotHeight + editPad
                Layout.leftMargin: needsMargin ? 12 : 0
                Layout.rightMargin: needsMargin ? 12 : 0
                visible: Layout.preferredHeight > 0

                readonly property bool needsMargin: ["context", "note", "media", "crypto", "wallpaper"].includes(modelData)
                readonly property bool isBeingDragged: root.dragIndex === index
                readonly property bool isDropTarget: root.hoverIndex === index && root.dragIndex !== index && root.dragIndex >= 0
                readonly property real displacementY: root.getDisplacementY(index)
                readonly property real dragFollowY: root.getDragFollowY()

                // ─── Staggered entrance animation ────────────────────
                readonly property int staggerDelay: 25
                property bool animatedIn: false

                onVisibleChanged: if (!visible) animatedIn = false

                Timer {
                    id: staggerTimer
                    interval: widgetWrapper.index * widgetWrapper.staggerDelay + 20
                    running: root.animateIn && !widgetWrapper.animatedIn
                    onTriggered: widgetWrapper.animatedIn = true
                }

                opacity: animatedIn ? 1 : 0
                scale: animatedIn ? 1 : 0.96
                transformOrigin: Item.Center

                // Combine entrance, displacement and drag-follow transforms
                transform: Translate {
                    y: {
                        if (!widgetWrapper.animatedIn) return 14
                        if (widgetWrapper.isBeingDragged) return widgetWrapper.dragFollowY
                        return widgetWrapper.displacementY
                    }

                    Behavior on y {
                        enabled: Appearance.animationsEnabled && !widgetWrapper.isBeingDragged
                        NumberAnimation {
                            duration: 280
                            easing.type: Easing.OutCubic
                        }
                    }
                }

                Behavior on opacity {
                    enabled: Appearance.animationsEnabled
                    NumberAnimation {
                        duration: 500
                        easing.type: Easing.BezierSpline
                        easing.bezierCurve: Appearance.animationCurves.emphasizedDecel
                    }
                }
                Behavior on scale {
                    enabled: Appearance.animationsEnabled && !widgetWrapper.isBeingDragged
                    NumberAnimation {
                        duration: 150
                        easing.type: Easing.OutCubic
                    }
                }

                // ─── Drop indicator bar (tri-style aware) ────────────
                Rectangle {
                    id: dropGhostTop
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.topMargin: -root.widgetSpacing / 2 - height / 2
                    anchors.leftMargin: 12
                    anchors.rightMargin: 12
                    height: 3
                    radius: 1.5
                    color: Appearance.inirEverywhere ? Appearance.inir.colPrimary
                         : Appearance.colors.colPrimary
                    opacity: widgetWrapper.isDropTarget && root.hoverIndex < root.dragIndex ? 0.85 : 0
                    visible: opacity > 0
                    z: 10

                    Behavior on opacity {
                        enabled: Appearance.animationsEnabled
                        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
                    }

                    // Subtle glow (hidden in inir style)
                    Rectangle {
                        visible: !Appearance.inirEverywhere
                        anchors.centerIn: parent
                        width: parent.width + 6
                        height: 10
                        radius: 5
                        color: ColorUtils.transparentize(Appearance.colors.colPrimary, 0.82)
                        z: -1
                    }
                }

                Rectangle {
                    id: dropGhostBottom
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: -root.widgetSpacing / 2 - height / 2
                    anchors.leftMargin: 12
                    anchors.rightMargin: 12
                    height: 3
                    radius: 1.5
                    color: Appearance.inirEverywhere ? Appearance.inir.colPrimary
                         : Appearance.colors.colPrimary
                    opacity: widgetWrapper.isDropTarget && root.hoverIndex > root.dragIndex ? 0.85 : 0
                    visible: opacity > 0
                    z: 10

                    Behavior on opacity {
                        enabled: Appearance.animationsEnabled
                        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
                    }

                    Rectangle {
                        visible: !Appearance.inirEverywhere
                        anchors.centerIn: parent
                        width: parent.width + 6
                        height: 10
                        radius: 5
                        color: ColorUtils.transparentize(Appearance.colors.colPrimary, 0.82)
                        z: -1
                    }
                }

                // ─── Content + visual feedback ───────────────────────
                Item {
                    id: contentContainer
                    anchors.fill: parent

                    // Elevated shadow when dragging
                    StyledRectangularShadow {
                        target: contentLoader
                        anchors.fill: contentLoader
                        opacity: widgetWrapper.isBeingDragged ? 0.6 : 0
                        blur: 28
                        spread: 0.18
                        color: Appearance.colors.colShadow

                        Behavior on opacity {
                            enabled: Appearance.animationsEnabled
                            NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
                        }
                    }

                    Loader {
                        id: contentLoader
                        width: parent.width
                        enabled: !root.arranging // KWin port: no accidental clicks while arranging
                        // KWin port: items that can use extra height (quick note, spacers) stretch to
                        // their tall/fill slot; the rest keep their natural height, centred in it.
                        // Always an explicit binding: resetting to undefined after "tall" kept the old
                        // height and overlapped the next item.
                        readonly property bool stretches: widgetWrapper.isSpacer || widgetWrapper.modelData === "note"
                        height: stretches ? widgetWrapper.slotHeight : widgetWrapper.naturalHeight
                        y: widgetWrapper.editPad + (stretches ? 0 : Math.max(0, Math.round((widgetWrapper.slotHeight - height) / 2)))

                        // Visual feedback when dragging
                        scale: widgetWrapper.isBeingDragged ? 1.02 : 1
                        opacity: widgetWrapper.isBeingDragged ? 0.9
                               : (root.editMode && !widgetWrapper.isDropTarget ? 0.65 : 1)

                        Behavior on scale {
                            enabled: Appearance.animationsEnabled
                            NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
                        }
                        Behavior on opacity {
                            enabled: Appearance.animationsEnabled
                            NumberAnimation { duration: 200; easing.type: Easing.OutCubic }
                        }

                        sourceComponent: {
                            switch (widgetWrapper.modelData) {
                            case "media": return mediaWidget
                            case "week": return weekWidget
                            case "context": return contextWidget
                            case "note": return noteWidget
                            case "launch": return launchWidget
                            case "controls": return controlsWidget
                            case "status": return statusWidget
                            case "crypto": return cryptoWidget
                            case "wallpaper": return wallpaperWidget
                            case "worldclock": return worldClockWidget
                            default: return widgetWrapper.isSpacer ? spacerWidget : null
                            }
                        }
                    }

                    // Accent tint overlay when dragging (tri-style)
                    Rectangle {
                        anchors.fill: contentLoader
                        radius: contentLoader.item?.radius ?? Appearance.rounding.small
                        color: Appearance.inirEverywhere ? Appearance.inir.colPrimary
                             : Appearance.colors.colPrimary
                        opacity: widgetWrapper.isBeingDragged ? 0.05 : 0

                        Behavior on opacity {
                            enabled: Appearance.animationsEnabled
                            NumberAnimation { duration: 180 }
                        }
                    }

                    // Selection border when dragging (tri-style)
                    Rectangle {
                        anchors.fill: contentLoader
                        radius: contentLoader.item?.radius ?? Appearance.rounding.small
                        color: "transparent"
                        border.width: widgetWrapper.isBeingDragged ? 1.5 : 0
                        border.color: Appearance.inirEverywhere
                            ? Appearance.inir.colBorderFocus
                            : ColorUtils.transparentize(Appearance.colors.colPrimary, 0.4)

                        Behavior on border.width {
                            enabled: Appearance.animationsEnabled
                            NumberAnimation { duration: 180 }
                        }
                    }

                    // ─── Drag handle: small grip button (top-right) ──
                    // Only covers a tiny area so widget content is never blocked.
                    // Appears on hover over the widget; always visible in edit mode.
                    Rectangle {
                        id: dragHandle
                        anchors.top: contentLoader.top
                        anchors.right: contentLoader.right
                        anchors.topMargin: root.arranging ? 2 - widgetWrapper.editPad : 4 // KWin port: in the edit strip
                        anchors.rightMargin: widgetWrapper.isSpacer || widgetWrapper.placeholder ? 16 : 4
                        width: 30
                        height: 22
                        radius: Appearance.inirEverywhere ? Appearance.inir.roundingSmall
                              : Appearance.rounding.verysmall
                        z: 10

                        color: handleMouseArea.containsMouse || widgetWrapper.isBeingDragged
                            ? (Appearance.angelEverywhere ? Appearance.angel.colGlassCardHover
                               : Appearance.inirEverywhere ? Appearance.inir.colLayer1Hover
                               : Appearance.auroraEverywhere ? Appearance.aurora.colSubSurface
                               : Appearance.colLayer1Hover)
                            : ColorUtils.transparentize(
                                Appearance.angelEverywhere ? Appearance.angel.colGlassCard
                                    : Appearance.inirEverywhere ? Appearance.inir.colLayer1
                                    : Appearance.colors.colLayer1, 0.15)

                        border.width: Appearance.inirEverywhere ? 1 : 0
                        border.color: Appearance.inirEverywhere ? Appearance.inir.colBorder : "transparent"

                        opacity: (handleHoverDetector.containsMouse || root.editMode || root.arranging) ? 1 : 0
                        visible: opacity > 0

                        Behavior on opacity {
                            enabled: Appearance.animationsEnabled
                            NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
                        }
                        Behavior on color {
                            enabled: Appearance.animationsEnabled
                            ColorAnimation { duration: 120 }
                        }

                        MaterialSymbol {
                            anchors.centerIn: parent
                            text: "drag_indicator"
                            iconSize: 14
                            color: handleMouseArea.containsMouse || widgetWrapper.isBeingDragged
                                ? (Appearance.inirEverywhere ? Appearance.inir.colOnLayer1
                                    : Appearance.colors.colOnLayer1)
                                : (Appearance.inirEverywhere ? Appearance.inir.colTextSecondary
                                    : Appearance.colors.colSubtext)
                        }

                        MouseArea {
                            id: handleMouseArea
                            anchors.fill: parent
                            anchors.margins: -3 // Slightly larger hit area
                            z: 20
                            hoverEnabled: true
                            cursorShape: root.editMode && root.dragIndex === widgetWrapper.index
                                ? Qt.ClosedHandCursor
                                : Qt.OpenHandCursor
                            acceptedButtons: Qt.LeftButton

                            property real pressY: 0
                            property bool dragStarted: false

                            onPressed: (mouse) => {
                                dragStarted = false
                                pressY = mapToItem(column, mouse.x, mouse.y).y
                                root.dragPending = true
                                handleDragStartTimer.restart()
                            }

                            onPositionChanged: (mouse) => {
                                if (root.editMode && root.dragIndex === widgetWrapper.index) {
                                    const globalY = mapToItem(column, mouse.x, mouse.y).y
                                    root.updateDrag(globalY)
                                } else if (!dragStarted) {
                                    const globalY = mapToItem(column, mouse.x, mouse.y).y
                                    if (Math.abs(globalY - pressY) > 5) {
                                        handleDragStartTimer.stop()
                                        dragStarted = true
                                        root.startDrag(widgetWrapper.index, globalY)
                                    }
                                }
                            }

                            onReleased: {
                                handleDragStartTimer.stop()
                                if (root.editMode) {
                                    root.endDrag()
                                }
                                dragStarted = false
                                root.dragPending = false
                            }

                            onCanceled: {
                                handleDragStartTimer.stop()
                                if (root.editMode) {
                                    root.cancelDrag()
                                }
                                dragStarted = false
                                root.dragPending = false
                            }

                            Timer {
                                id: handleDragStartTimer
                                interval: 150
                                onTriggered: {
                                    handleMouseArea.dragStarted = true
                                    const globalY = handleMouseArea.mapToItem(column, handleMouseArea.mouseX, handleMouseArea.mouseY).y
                                    root.startDrag(widgetWrapper.index, globalY)
                                }
                            }
                        }
                    }

                    // KWin port: placeholder for an enabled item with nothing to show
                    Rectangle {
                        anchors.fill: parent
                        anchors.topMargin: widgetWrapper.editPad
                        anchors.leftMargin: 12
                        anchors.rightMargin: 12
                        visible: widgetWrapper.placeholder
                        radius: Appearance.rounding.small
                        color: "transparent"
                        border.width: 1
                        border.color: Appearance.colors.colOutlineVariant
                        StyledText {
                            anchors.left: parent.left
                            anchors.leftMargin: 40
                            anchors.verticalCenter: parent.verticalCenter
                            text: (root.itemLabels[widgetWrapper.modelData] ?? widgetWrapper.modelData)
                                + (widgetWrapper.modelData === "media" ? " — " + Translation.tr("shows while something plays") : "")
                            font.pixelSize: Appearance.font.pixelSize.smaller
                            color: Appearance.colors.colSubtext
                        }
                    }

                    // Hover detector covering the whole widget to reveal the grip button
                    HoverHandler {
                        id: handleHoverDetector
                    }
                }

                // ─── Long press to drag (fallback, behind content) ───
                MouseArea {
                    id: dragArea
                    anchors.fill: parent
                    // KWin port: while arranging, sits above the (disabled) content and drags on move
                    z: root.arranging ? 15 : -1
                    cursorShape: root.arranging ? Qt.OpenHandCursor : Qt.ArrowCursor
                    acceptedButtons: Qt.LeftButton

                    property bool longPressTriggered: false
                    property real pressY: 0

                    onWheel: (wheel) => wheel.accepted = false

                    onPressed: (mouse) => {
                        longPressTriggered = false
                        pressY = mapToItem(column, mouse.x, mouse.y).y
                        if (root.arranging) root.dragPending = true // keep the tab from scrolling
                        else longPressTimer.restart()
                    }

                    onPositionChanged: (mouse) => {
                        if (root.editMode && root.dragIndex === widgetWrapper.index) {
                            const globalY = mapToItem(column, mouse.x, mouse.y).y
                            root.updateDrag(globalY)
                        } else if (!longPressTriggered) {
                            const globalY = mapToItem(column, mouse.x, mouse.y).y
                            if (root.arranging && Math.abs(globalY - pressY) > 5) {
                                longPressTriggered = true
                                root.startDrag(widgetWrapper.index, globalY)
                            } else if (Math.abs(globalY - pressY) > 10) {
                                longPressTimer.stop()
                            }
                        }
                    }

                    onReleased: {
                        longPressTimer.stop()
                        if (root.editMode) {
                            root.endDrag()
                        }
                        longPressTriggered = false
                        if (root.arranging) root.dragPending = false
                    }

                    onCanceled: {
                        longPressTimer.stop()
                        if (root.editMode) {
                            root.cancelDrag()
                        }
                        longPressTriggered = false
                        if (root.arranging) root.dragPending = false
                    }

                    Timer {
                        id: longPressTimer
                        interval: 300
                        onTriggered: {
                            dragArea.longPressTriggered = true
                            const globalY = dragArea.mapToItem(column, dragArea.mouseX, dragArea.mouseY).y
                            root.startDrag(widgetWrapper.index, globalY)
                        }
                    }
                }

                // KWin port: edit-mode controls — remove (top-left), size chip. A direct child of the
                // delegate so its z sits above dragArea (z 15); inside contentContainer the drag
                // layer swallowed every click. Declared after dragArea too, so declaration order agrees.
                Row {
                    anchors.top: parent.top
                    anchors.left: parent.left
                    anchors.topMargin: 2
                    anchors.leftMargin: widgetWrapper.isSpacer || widgetWrapper.placeholder ? 16 : 4
                    spacing: 4
                    z: 30
                    visible: opacity > 0
                    opacity: root.arranging && !widgetWrapper.isBeingDragged ? 1 : 0
                    Behavior on opacity {
                        enabled: Appearance.animationsEnabled
                        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
                    }

                    EditChip {
                        glyph: "close"
                        tipText: widgetWrapper.isSpacer ? Translation.tr("Remove spacer") : Translation.tr("Hide")
                        onClicked: root.removeItem(widgetWrapper.modelData)
                    }
                    EditChip {
                        visible: !widgetWrapper.isSpacer
                        glyph: widgetWrapper.sizeMode === "fill" ? "height" : widgetWrapper.sizeMode === "tall" ? "expand" : "check_indeterminate_small"
                        label: widgetWrapper.sizeMode === "fill" ? Translation.tr("Fill")
                             : widgetWrapper.sizeMode === "tall" ? Translation.tr("Tall") : Translation.tr("Normal")
                        tipText: Translation.tr("Size: click to cycle Normal → Tall → Fill")
                        onClicked: root.cycleSize(widgetWrapper.modelData)
                    }
                }
            }
        }

        // ─── KWin port: Add tray + Edit/Done ────────────────────────────
        Flow {
            id: addTray
            Layout.fillWidth: true
            // Explicit width: while hidden the layout doesn't size it, and a Flow sized from
            // children whose width follows the Flow relayouts forever (hung the sidebar).
            width: root.width - 24
            Layout.leftMargin: 12
            Layout.rightMargin: 12
            Layout.topMargin: 4
            spacing: 6
            visible: root.arranging

            StyledText {
                width: root.width - 24
                text: root.hiddenItems.length > 0 ? Translation.tr("Add") : Translation.tr("Add a spacer")
                font.pixelSize: Appearance.font.pixelSize.smaller
                color: Appearance.colors.colSubtext
            }
            Repeater {
                model: root.hiddenItems
                delegate: EditChip {
                    required property string modelData
                    glyph: root.itemIcons[modelData] ?? "add"
                    label: root.itemLabels[modelData] ?? modelData
                    tipText: Translation.tr("Show %1").arg(label)
                    onClicked: root.setShown(modelData, true)
                }
            }
            EditChip {
                glyph: "space_bar"
                label: Translation.tr("Spacer")
                tipText: Translation.tr("Add a blank gap (drag it into place)")
                onClicked: root.addSpacer()
            }
        }

        EditChip {
            id: editButton
            Layout.alignment: Qt.AlignHCenter
            Layout.topMargin: 6
            glyph: root.arranging ? "check" : "edit"
            label: root.arranging ? Translation.tr("Done") : Translation.tr("Edit")
            accent: root.arranging
            tipText: root.arranging ? Translation.tr("Finish editing") : Translation.tr("Move, hide, resize and add widgets")
            onClicked: { root.cancelDrag(); root.arranging = !root.arranging }
        }
    }

    Component {
        id: mediaWidget
        MediaPlayerWidget {}
    }
    Component {
        id: weekWidget
        WeekStrip {}
    }
    Component {
        id: contextWidget
        ContextCard {}
    }
    Component {
        id: noteWidget
        QuickNote {}
    }
    Component {
        id: launchWidget
        QuickLaunch {}
    }
    Component {
        id: controlsWidget
        ControlsCard {}
    }
    Component {
        id: statusWidget
        StatusRings {}
    }
    Component {
        id: cryptoWidget
        CryptoWidget {}
    }
    Component {
        id: wallpaperWidget
        QuickWallpaper {}
    }
    Component {
        id: worldClockWidget
        WorldClockWidget {}
    }
    // KWin port: blank spacer — invisible, except a faint outline while rearranging so it
    // can be found and dragged. Its height comes from the wrapper (sidebar.widgets.spacers).
    Component {
        id: spacerWidget
        Item {
            implicitHeight: 0
            Rectangle {
                anchors.fill: parent
                anchors.leftMargin: 12
                anchors.rightMargin: 12
                radius: Appearance.rounding.small
                color: "transparent"
                border.width: 1
                border.color: Appearance.colors.colOutlineVariant
                opacity: (root.editMode || root.arranging) ? 0.8 : 0
                visible: opacity > 0
                Behavior on opacity {
                    enabled: Appearance.animationsEnabled
                    NumberAnimation { duration: Appearance.animation.elementMoveFast.duration; easing.type: Appearance.animation.elementMoveFast.type; easing.bezierCurve: Appearance.animation.elementMoveFast.bezierCurve }
                }
            }
        }
    }

    // KWin port: small pill button for the edit controls
    component EditChip: RippleButton {
        id: chip
        property string glyph
        property string label: ""
        property string tipText
        property bool accent: false
        implicitHeight: 24
        implicitWidth: chipRow.implicitWidth + (chip.label.length > 0 ? 16 : 8)
        buttonRadius: Appearance.rounding.full
        colBackground: chip.accent ? Appearance.colors.colPrimary
            : ColorUtils.transparentize(Appearance.colors.colLayer2, 0.1)
        colBackgroundHover: chip.accent ? Appearance.colors.colPrimaryHover : Appearance.colLayer2Hover
        colRipple: chip.accent ? Appearance.colors.colPrimaryActive : Appearance.colLayer2Active
        contentItem: Item {
            Row {
                id: chipRow
                anchors.centerIn: parent
                spacing: 4
                MaterialSymbol {
                    anchors.verticalCenter: parent.verticalCenter
                    text: chip.glyph
                    iconSize: 14
                    color: chip.accent ? Appearance.colors.colOnPrimary : Appearance.colors.colOnLayer2
                }
                StyledText {
                    anchors.verticalCenter: parent.verticalCenter
                    visible: chip.label.length > 0
                    text: chip.label
                    font.pixelSize: Appearance.font.pixelSize.smaller
                    color: chip.accent ? Appearance.colors.colOnPrimary : Appearance.colors.colOnLayer2
                }
            }
        }
        StyledToolTip { text: chip.tipText }
    }
}
