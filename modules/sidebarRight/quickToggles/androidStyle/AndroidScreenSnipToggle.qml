import qs
import qs.modules.common
import qs.modules.common.widgets
import qs.services
import QtQuick
import Quickshell

AndroidQuickToggleButton {
    id: root

    name: Translation.tr("Screen snip")
    statusText: ""
    toggled: false
    buttonIcon: "screenshot_region"

    mainAction: () => {
        GlobalStates.sidebarRightOpen = false;
        delayedActionTimer.start()
    }
    Timer {
        id: delayedActionTimer
        interval: 300
        repeat: false
        onTriggered: {
            // KWin port: scripts/inir isn't shipped; Spectacle does region capture on
            // Plasma (-r region, -b no editor window, -c copy the capture to the clipboard).
            Quickshell.execDetached(["/usr/bin/spectacle", "-r", "-b", "-c"])
        }
    }

    StyledToolTip {
        text: Translation.tr("Screen snip")
    }
}
