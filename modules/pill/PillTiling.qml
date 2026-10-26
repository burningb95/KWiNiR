pragma ComponentBehavior: Bound

import QtQuick
import qs.services
import qs.modules.common

/**
 * KWin port, NEW (upstream has no equivalent): a minimap of the scrolling tiler's columns for
 * one monitor, shown beside the workspace dots while tiling is on. One rounded segment per
 * column, in proportion to its width; the focused column is the accent colour, columns that
 * are on screen are bright, columns scrolled out of view (minimized by the tiler) are dim.
 * Click a segment to focus that column. Fixed width, so it never reflows the pill as windows
 * come and go; it collapses entirely when the monitor has nothing tiled. A portrait monitor's
 * strip runs top to bottom, so there the segments stack vertically (one per row).
 */
Item {
    id: strip

    property string screenName: ""
    property real s: 1

    readonly property var info: {
        const t = KWinBridge.tiling
        return t?.enabled ? (t.outputs?.[strip.screenName] ?? null) : null
    }
    readonly property var columns: strip.info?.columns ?? []
    readonly property bool shown: CompositorService.isKWin && strip.columns.length > 0
    readonly property bool vertical: strip.info?.vertical === true
    readonly property real fullW: (strip.vertical ? 14 : 64) * strip.s
    readonly property real fullL: (strip.vertical ? 26 : 64) * strip.s   // length of the strip axis
    readonly property real segGap: 3 * strip.s
    readonly property real segH: 8 * strip.s

    /** Segment geometry as {x, w, visible, focused}, laid along fullL in proportion to size. */
    readonly property var segments: {
        const cols = strip.columns
        const n = cols.length
        if (n === 0)
            return []
        let total = 0
        for (let i = 0; i < n; i++)
            total += Math.max(0.05, Number(cols[i].width) || 0.5)
        const room = Math.max(1, strip.fullL - strip.segGap * (n - 1))
        const out = []
        let x = 0
        for (let i = 0; i < n; i++) {
            const w = Math.max(2, room * Math.max(0.05, Number(cols[i].width) || 0.5) / total)
            out.push({ x: x, w: w, visible: cols[i].visible === true,
                       focused: i === strip.info.focusedColumn,
                       stacked: (cols[i].windows?.length ?? 0) > 1 })
            x += w + strip.segGap
        }
        return out
    }

    visible: strip.shown
    implicitWidth: strip.shown ? strip.fullW : 0
    implicitHeight: 30 * strip.s

    Repeater {
        model: strip.segments

        delegate: Item {
            id: seg
            required property var modelData
            required property int index

            x: strip.vertical ? 0 : seg.modelData.x
            y: strip.vertical ? (parent.height - strip.fullL) / 2 + seg.modelData.x : 0
            width: strip.vertical ? strip.fullW : seg.modelData.w
            height: strip.vertical ? seg.modelData.w : parent.height

            Rectangle {
                anchors.centerIn: parent
                width: strip.vertical ? strip.fullW : parent.width
                height: strip.vertical ? parent.height : strip.segH
                radius: Math.min(width, height) / 2
                color: seg.modelData.focused ? PillTheme.vermLit : PillTheme.cream
                opacity: seg.modelData.focused ? 1.0
                       : seg.modelData.visible ? (area.containsMouse ? 0.8 : 0.55)
                       : (area.containsMouse ? 0.5 : 0.22)
                Behavior on opacity { NumberAnimation { duration: PillMotion.fast } }

                // A column holding several windows gets a hairline split.
                Rectangle {
                    visible: seg.modelData.stacked
                    anchors.centerIn: parent
                    width: strip.vertical ? 1 : parent.width
                    height: strip.vertical ? parent.height : 1
                    color: PillTheme.hair
                }
            }

            MouseArea {
                id: area
                anchors.fill: parent
                anchors.leftMargin: strip.vertical ? 0 : -strip.segGap / 2
                anchors.rightMargin: strip.vertical ? 0 : -strip.segGap / 2
                anchors.topMargin: strip.vertical ? -strip.segGap / 2 : 0
                anchors.bottomMargin: strip.vertical ? -strip.segGap / 2 : 0
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: KWinBridge.sendTiling("focus-column", seg.index)
            }
        }
    }
}
