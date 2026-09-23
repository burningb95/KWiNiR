pragma Singleton

import QtQuick
import Qt.labs.folderlistmodel
import Quickshell
import qs.modules.common

/**
 * KWin port: burningb95's palettes (extras/theme/colors.<name>.json) as
 * one-click presets. apply() backs up the live colors.json (last 5 kept, same
 * rotation as the built-in presets), copies the chosen file over it and puts
 * appearance.theme back to "auto", so MaterialThemeLoader reads it and the
 * shell recolors live. Nothing outside the bar's own files is touched.
 */
Singleton {
    id: root

    readonly property string dir: Quickshell.shellPath("extras/theme")
    readonly property string current: Config.options?.appearance?.userPalette ?? ""
    readonly property var names: {
        const out = []
        for (let i = 0; i < folder.count; i++) {
            const m = /^colors\.(.+)\.json$/.exec(folder.get(i, "fileName") ?? "")
            if (m) out.push(m[1])
        }
        return out
    }

    FolderListModel {
        id: folder
        folder: `file://${root.dir}`
        nameFilters: ["colors.*.json"]
        showDirs: false
    }

    function apply(name: string): bool {
        if (!root.names.includes(name)) {
            console.warn("[UserPalettes] unknown palette:", name, "- have:", root.names.join(", "))
            return false
        }
        Quickshell.execDetached(["/usr/bin/bash", "-c",
            'f="$2"; [ -s "$f" ] && cp -p "$f" "$f.bak-$(date +%s)"; ls -t "$f".bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f; cp "$1" "$f"',
            "bash", `${root.dir}/colors.${name}.json`, Directories.generatedMaterialThemePath])
        Config.setNestedValues({ "appearance.theme": "auto", "appearance.userPalette": name })
        return true
    }
}
