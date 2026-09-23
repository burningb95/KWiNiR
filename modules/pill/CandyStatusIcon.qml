import QtQuick
import Quickshell
import Quickshell.Widgets

/**
 * KWin port addition: a status indicator drawn from the candy-icons theme
 * (status/ icons: wifi signal, bell, battery, volume, playback). The shell's
 * icon theme is candy-icons (`//@ pragma IconTheme` in shell.qml), so a plain
 * theme lookup lands in candy.
 *
 * Candy icons carry their own gradient colors, so the pill's idle/hover tint
 * (iconDim -> cream on the hand-drawn glyphs this replaces) is expressed as
 * opacity instead: slightly dimmed at rest, full on hover, eased with the
 * pill's own fast token.
 */
Item {
    id: root

    property string name: ""
    property bool hovered: false
    property real restOpacity: 0.82

    implicitWidth: 18
    implicitHeight: 18

    IconImage {
        anchors.fill: parent
        source: root.name.length > 0 ? Quickshell.iconPath(root.name, true) : ""
        opacity: root.hovered ? 1 : root.restOpacity
        Behavior on opacity {
            NumberAnimation { duration: PillMotion.fast; easing.type: PillMotion.easeStandard }
        }
    }
}
