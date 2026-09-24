pragma Singleton
pragma ComponentBehavior: Bound

import qs.modules.common.functions
import qs.services
import QtCore
import QtQuick
import Quickshell
import Quickshell.Io

Singleton {
    id: root

    // XDG Dirs, with "file://"
    readonly property string home: StandardPaths.standardLocations(StandardPaths.HomeLocation)[0]
    readonly property string config: StandardPaths.standardLocations(StandardPaths.ConfigLocation)[0]
    readonly property string state: StandardPaths.standardLocations(StandardPaths.StateLocation)[0]
    readonly property string cache: StandardPaths.standardLocations(StandardPaths.CacheLocation)[0]
    readonly property string genericCache: StandardPaths.standardLocations(StandardPaths.GenericCacheLocation)[0]
    readonly property string documents: StandardPaths.standardLocations(StandardPaths.DocumentsLocation)[0]
    readonly property string downloads: StandardPaths.standardLocations(StandardPaths.DownloadLocation)[0]
    readonly property string pictures: StandardPaths.standardLocations(StandardPaths.PicturesLocation)[0]
    readonly property string music: StandardPaths.standardLocations(StandardPaths.MusicLocation)[0]
    readonly property string videos: StandardPaths.standardLocations(StandardPaths.MoviesLocation)[0]
    readonly property string homePath: FileUtils.trimFileProtocol(home)
    readonly property string configPath: FileUtils.trimFileProtocol(config)
    readonly property string statePath: FileUtils.trimFileProtocol(state)
    readonly property string cachePath: FileUtils.trimFileProtocol(cache)
    readonly property string genericCachePath: FileUtils.trimFileProtocol(genericCache)
    readonly property string documentsPath: FileUtils.trimFileProtocol(documents)
    readonly property string downloadsPath: FileUtils.trimFileProtocol(downloads)
    readonly property string picturesPath: FileUtils.trimFileProtocol(pictures)
    readonly property string musicPath: FileUtils.trimFileProtocol(music)
    readonly property string videosPath: FileUtils.trimFileProtocol(videos)

    // Other dirs used by the shell, without "file://"
    property string assetsPath: Quickshell.shellPath("assets")
    property string scriptPath: Quickshell.shellPath("scripts")
    property string scriptsPath: FileUtils.trimFileProtocol(scriptPath)
    property string stateUserPath: `${Directories.statePath}/user`
    property string wallpapersPath: Config.options?.wallpapers?.directory || `${Directories.picturesPath}/Wallpapers`
    property string screenshotsPath: Config.options?.regionSelector?.savePath || `${Directories.picturesPath}/Screenshots`
    property string persistentStatesPath: `${Directories.statePath}/states.json`
    property string eventsPath: `${Directories.stateUserPath}/events.json`
    property string screenTimePath: `${Directories.stateUserPath}/screentime`
    property string generatedMaterialScssPath: `${Directories.stateUserPath}/generated/material_colors.scss`
    property string favicons: `${Directories.cachePath}/media/favicons`
    // User avatar paths
    property string userAvatarPathAccountsService: FileUtils.trimFileProtocol(`/var/lib/AccountsService/icons/${SystemInfo.username}`)
    property string userAvatarPathRicersAndWeirdSystems: `${Directories.homePath}/.face`
    property string userAvatarPathRicersAndWeirdSystems2: `${Directories.homePath}/.face.icon`
    /**
     * KWin port: a bar-only avatar, tried first. The other three are the
     * account picture Plasma and SDDM also show, so setting one of those just
     * for this sidebar would change the login screen too. No suffix: Qt's
     * image loader probes known extensions, so avatar.png / avatar.jpg both work.
     */
    // sidebar.right.avatarPath overrides it ("" = this default; "~/" is expanded).
    readonly property string _avatarPathSetting: String(Config.options?.sidebar?.right?.avatarPath ?? "").trim()
    property string userAvatarPathPillbar: _avatarPathSetting.length > 0
        ? FileUtils.trimFileProtocol(_avatarPathSetting.startsWith("~/") ? `${Directories.homePath}/${_avatarPathSetting.slice(2)}` : _avatarPathSetting)
        : `${Directories.shellConfig}/avatar`
    property int userAvatarRevision: 0
    readonly property var userAvatarPaths: [
        userAvatarPathPillbar,
        userAvatarPathAccountsService,
        userAvatarPathRicersAndWeirdSystems,
        userAvatarPathRicersAndWeirdSystems2
    ].filter(path => String(path ?? "").trim().length > 0)
    readonly property string userAvatarSourcePrimary: avatarSourceAt(0)

    FileView {
        path: root.userAvatarPathAccountsService
        watchChanges: true
        // Optional: most users have no AccountsService picture; don't log "does not exist" every start.
        printErrors: false
        onFileChanged: root.userAvatarRevision++
    }
    property string coverArt: `${Directories.cachePath}/media/coverart`
    /**
     * KWin port: private scratch space in $XDG_RUNTIME_DIR (0700, tmpfs) instead of fixed
     * /tmp/quickshell paths. /tmp is shared: other users could read decoded clipboard
     * images and screenshots, pre-create or symlink these dirs (the startup `rm -rf`
     * follows a symlinked parent), or swap the AI request script before it runs.
     */
    property string runtimeTemp: `${Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"}/kwinir`
    property string tempImages: `${runtimeTemp}/media/images`
    property string booruPreviews: `${Directories.cachePath}/media/boorus`
    property string booruDownloads: Config.options?.sidebar?.booru?.downloadPath?.sfw || Directories.wallpapersPath
    property string booruDownloadsNsfw: Config.options?.sidebar?.booru?.downloadPath?.nsfw || `${Directories.wallpapersPath}/🌶️`
    property string latexOutput: `${Directories.cachePath}/media/latex`
    /**
     * KWin port: this standalone bar keeps its own config dir so it never
     * shares state with an iNiR install (the stock path
     * ~/.config/illogical-impulse is a symlink into ~/.config/inir).
     */
    property string shellConfig: `${Directories.configPath}/pillbar`
    property string shellConfigName: "config.json"
    property string shellConfigPath: `${Directories.shellConfig}/${Directories.shellConfigName}`
    property string updateLogPath: `${Directories.stateUserPath}/update.log`
    property string updateStatusPath: `${Directories.stateUserPath}/update-status`
    property string todoPath: `${Directories.stateUserPath}/todo.json`
    property string todoTxtPath: `${Directories.stateUserPath}/todo.txt`
    property string notepadPath: `${Directories.stateUserPath}/notepad.txt`
    property string notesPath: `${Directories.stateUserPath}/notes.txt`
    property string conflictCachePath: `${Directories.cachePath}/conflict-killer`
    property string notificationsPath: `${Directories.stateUserPath}/notifications.json`
    property string calendarSyncCachePath: `${Directories.stateUserPath}/calendar-sync-cache.json`
    property string generatedMaterialThemePath: `${Directories.stateUserPath}/generated/colors.json`
    property string generatedPalettePath: `${Directories.stateUserPath}/generated/palette.json`
    property string generatedAppPalettePath: `${Directories.stateUserPath}/generated/app-palette.json`
    property string generatedTerminalPalettePath: `${Directories.stateUserPath}/generated/terminal.json`
    property string generatedThemeMetaPath: `${Directories.stateUserPath}/generated/theme-meta.json`
    property string generatedChromiumThemePath: `${Directories.stateUserPath}/generated/chromium.theme`
    property string generatedWallpaperCategoryPath: `${Directories.stateUserPath}/generated/wallpaper/category.txt`
    property string cliphistDecode: FileUtils.trimFileProtocol(`${runtimeTemp}/media/cliphist`)
    property string screenshotTemp: `${runtimeTemp}/media/screenshot`
    // KWin port: switchwall.sh regenerates colors for terminals, GTK, Qt, etc. — the
    // system-wide takeover this port exists to avoid. Its 15 call sites all read
    // this path, so it is blocked here on purpose (not merely "not shipped").
    property string wallpaperSwitchScriptPath: "/nonexistent/kwin-port-blocked/switchwall.sh"
    property string defaultAiPrompts: Quickshell.shellPath("defaults/ai/prompts")
    property string userAiPrompts: FileUtils.trimFileProtocol(`${Directories.shellConfig}/ai/prompts`)
    property string userActions: FileUtils.trimFileProtocol(`${Directories.shellConfig}/actions`)
    property string aiChats: `${Directories.stateUserPath}/ai/chats`
    property string aiTranslationScriptPath: `${Directories.scriptsPath}/ai/gemini-translate.sh`
    property string recordScriptPath: `${Directories.scriptsPath}/videos/record.sh`

    function shortHomePath(path: string): string {
        const cleaned = FileUtils.trimFileProtocol(path)
        if (cleaned === root.homePath)
            return "~"
        if (cleaned.startsWith(root.homePath + "/"))
            return "~" + cleaned.slice(root.homePath.length)
        return cleaned
    }

    function avatarSourceAt(index: int): string {
        if (index < 0 || index >= userAvatarPaths.length)
            return ""

        const path = String(userAvatarPaths[index] ?? "").trim()
        return path.length > 0 ? `file://${path}?inir-avatar=${root.userAvatarRevision}` : ""
    }

    function nextAvatarSource(currentSource: string): string {
        const normalized = String(currentSource ?? "")
            .replace(/^file:\/\//, "")
            .replace(/\?inir-avatar=\d+$/, "")

        for (let i = 0; i < userAvatarPaths.length; ++i) {
            if (String(userAvatarPaths[i] ?? "") === normalized)
                return avatarSourceAt(i + 1)
        }

        return userAvatarSourcePrimary
    }
    // Cleanup on init
    Component.onCompleted: {
        Quickshell.execDetached(["mkdir", "-p", "-m", "700", `${runtimeTemp}/ai`])
        Quickshell.execDetached(["mkdir", "-p", `${shellConfig}`])
        Quickshell.execDetached(["mkdir", "-p", `${stateUserPath}`])
        Quickshell.execDetached(["mkdir", "-p", `${favicons}`])
        Quickshell.execDetached(["mkdir", "-p", `${coverArt}`])
        Quickshell.execDetached(["rm", "-rf", `${booruPreviews}`])
        Quickshell.execDetached(["mkdir", "-p", `${booruPreviews}`])
        Quickshell.execDetached(["rm", "-rf", `${latexOutput}`])
        Quickshell.execDetached(["mkdir", "-p", `${latexOutput}`])
        Quickshell.execDetached(["rm", "-rf", `${cliphistDecode}`])
        Quickshell.execDetached(["mkdir", "-p", `${cliphistDecode}`])
        Quickshell.execDetached(["mkdir", "-p", `${aiChats}`])
        Quickshell.execDetached(["mkdir", "-p", `${screenTimePath}`])
        Quickshell.execDetached(["mkdir", "-p", `${userActions}`])
        Quickshell.execDetached(["rm", "-rf", `${tempImages}`])
    }
}
