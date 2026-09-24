import qs
import qs.services
import qs.services.deferred
import qs.modules.common
import qs.modules.common.functions
import qs.modules.common.widgets
import QtQuick
import QtQuick.Layouts
import Quickshell

import qs.modules.sidebarRight.quickToggles.classicStyle

AbstractQuickPanel {
    id: root
    property bool compactMode: false
    property int compactItemSlotWidth: 48
    property int compactSpacing: 8
    
    implicitHeight: grid.implicitHeight
    Layout.fillWidth: true

    Grid {
        id: grid
        anchors.top: parent.top
        anchors.horizontalCenter: parent.horizontalCenter
        
        // Approximate width of a toggle (40) + spacing
        property int itemSlotWidth: root.compactMode ? root.compactItemSlotWidth : 52
        columns: Math.max(1, Math.floor(root.width / itemSlotWidth))
        
        spacing: root.compactMode ? root.compactSpacing : 12
        // KWin port: sidebar.quickToggles.hiddenTypes applies to the classic grid too.
        readonly property var hiddenTypes: Array.from(Config.options?.sidebar?.quickToggles?.hiddenTypes ?? [])
        
        NetworkToggle {
            visible: !grid.hiddenTypes.includes("network")
            altAction: () => root.openWifiDialog()
        }

        HotspotToggle {
            visible: !grid.hiddenTypes.includes("hotspot")
            altAction: () => root.openHotspotDialog()
        }

        BluetoothToggle {
            visible: BluetoothStatus.available && !grid.hiddenTypes.includes("bluetooth")
            altAction: () => root.openBluetoothDialog()
        }
        
        NightLight {
            visible: !grid.hiddenTypes.includes("nightLight")
            altAction: () => root.openNightLightDialog()
        }
        
        EasyEffectsToggle {
            visible: EasyEffects.available && !grid.hiddenTypes.includes("easyEffects")
            altAction: () => ShellExec.execDetachedArgs(["easyeffects"], "Open EasyEffects")
        }
        
        IdleInhibitor { visible: !grid.hiddenTypes.includes("idleInhibitor") }
        
        GameMode { visible: !grid.hiddenTypes.includes("gameMode") }
        
        // WARP decides its own visibility (warp-cli probe), so hide it by not loading it.
        Loader {
            active: !grid.hiddenTypes.includes("cloudflareWarp")
            visible: active && (item?.visible ?? false)
            sourceComponent: Component { CloudflareWarp {} }
        }
    }
}
