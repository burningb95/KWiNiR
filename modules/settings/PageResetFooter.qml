import QtQuick
import QtQuick.Layouts
import qs.services
import qs.modules.common
import qs.modules.common.widgets

/**
 * KWin port: per-page "reset to defaults". Resets every config path in `scope`
 * through Config.resetPath, either to burningb95's baseline snapshot or to iNiR's
 * shipped defaults. Two clicks: the first arms the button for 4 s.
 *
 *   PageResetFooter {
 *       scope: ["bar.pill", "appearance.candy"]
 *       description: Translation.tr("Puts every Pill option back.")
 *   }
 */
ContentSubsection {
    id: root

    property var scope: []
    property string description: ""
    property string armed: ""   // "", "baseline" or "factory"
    property string result: ""

    title: Translation.tr("Reset")

    function trigger(source: string): void {
        if (root.armed !== source) {
            root.armed = source
            armTimer.restart()
            return
        }
        root.armed = ""
        let n = 0
        for (const p of root.scope) n += Math.max(0, Config.resetPath(p, source))
        root.result = Translation.tr("Reset %1 values").arg(n)
    }
    Timer { id: armTimer; interval: 4000; onTriggered: root.armed = "" }

    StyledText {
        Layout.fillWidth: true
        text: root.result.length > 0 ? root.result
            : root.description + " " + Translation.tr("\"My setup\" is your saved baseline; \"iNiR defaults\" is the shipped configuration.")
        color: Appearance.colors.colSubtext
        font.pixelSize: Appearance.font.pixelSize.small
        wrapMode: Text.WordWrap
    }
    RowLayout {
        Layout.fillWidth: true
        spacing: 8
        Repeater {
            model: [
                { source: "baseline", label: Translation.tr("Reset to my setup"), icon: "restart_alt" },
                { source: "factory", label: Translation.tr("Reset to iNiR defaults"), icon: "settings_backup_restore" }
            ]
            RippleButton {
                id: resetButton
                required property var modelData
                readonly property bool isArmed: root.armed === modelData.source
                Layout.fillWidth: true
                implicitHeight: 36
                buttonRadius: Appearance.zzzEverywhere ? Appearance.zzz.controlRadius : Appearance.rounding.small
                colBackground: isArmed ? Appearance.colors.colErrorContainer : Appearance.colors.colLayer1
                colBackgroundHover: isArmed ? Appearance.colors.colErrorContainer : Appearance.colors.colLayer1Hover
                colRipple: Appearance.colors.colLayer1Active
                onClicked: root.trigger(modelData.source)

                RowLayout {
                    anchors.centerIn: parent
                    spacing: 8
                    MaterialSymbol {
                        text: resetButton.isArmed ? "warning" : resetButton.modelData.icon
                        iconSize: Appearance.font.pixelSize.normal
                        color: resetButton.isArmed ? Appearance.colors.colOnErrorContainer : Appearance.colors.colOnSurface
                    }
                    StyledText {
                        text: resetButton.isArmed ? Translation.tr("Click again to reset") : resetButton.modelData.label
                        font.pixelSize: Appearance.font.pixelSize.small
                        color: resetButton.isArmed ? Appearance.colors.colOnErrorContainer : Appearance.colors.colOnSurface
                    }
                }
            }
        }
    }
}
