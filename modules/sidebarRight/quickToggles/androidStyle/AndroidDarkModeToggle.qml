import qs.modules.common
import qs.modules.common.widgets
import qs.services
import QtQuick
import Quickshell

AndroidQuickToggleButton {
    id: root

    name: Translation.tr("Dark Mode")
    statusText: Appearance.m3colors.darkmode ? Translation.tr("Dark") : Translation.tr("Light")

    toggled: Appearance.m3colors.darkmode
    buttonIcon: "candy:dark-mode"  // KWin port: CandyGlyphs
    
    mainAction: () => {
        MaterialThemeLoader.setDarkMode(!Appearance.m3colors.darkmode)
    }

    StyledToolTip {
        text: Translation.tr("Dark Mode")
    }
}
