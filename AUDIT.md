# KWiNiR audit (branch `audit`)

Full review pass for bugs, efficiency and security, following burningb95's audit prompt
(verbatim copy outside the repo: `~/.local/share/Fancy-Floating-Bar/audit-prompt.md`).

**Rules in force:** fix clear bugs/warnings, performance changes that are invisible, and
security fixes that keep features — one commit per fix. Anything visual, behavioural,
default-changing, animation/timing-changing or restructuring goes to **Needs approval**.
Only files in this repo are touched; config is never reset.

**Resuming:** read this file, check `git log --oneline audit` against *Log*, continue at
**Next step**. Tools live in `~/.local/share/Fancy-Floating-Bar/tools/`
(`audit-inventory.py`, `measure-idle.sh`, `audit-commit.sh`, `render-settings.sh`,
`test-staging.sh` one level up). Edit in `staging/pillbar/`, promote with rsync
(`--exclude .git --exclude _harness.qml`), commit here on `audit`.

## Next step

Phase 2, remaining parts: (a) missing-data paths — read Battery/UPower, BluetoothStatus,
Network, MprisController, Audio (Pipewire) for null handling when the device/service is
absent or restarts; (b) config robustness — feed wrong types / unknown values for the port's
own options (rowOrder, candy, hiddenTypes, shellLayout, jobProgress, light.night) through
`tools/cfgset.py` on staging and watch the log; (c) init races — lazy singletons whose IPC
targets are missing at start (#3). Environment items that can't be exercised safely (monitor
hotplug, sleep/resume, KWin restart) get a code review instead.

## Plan

1. **Map** (this file: architecture, checklist) — done 2026-09-23.
2. **Bugs & robustness** — log warnings; missing battery/BT/network/media/audio; D-Bus
   restarts; monitor hotplug, sleep/resume, plasmashell/KWin restart, Quickshell reload;
   config robustness; init races.
3. **Efficiency** — polling timers → signals/watches; work while hidden; duplicate fetching;
   heavy bindings/images; before/after idle numbers.
4. **Security** — command injection (shell strings with outside data), rich text/remote
   resources, IPC surface, secrets/.gitignore/permissions, network (HTTPS/timeouts), temp files.
5. **Wrap up** — clean log, summary, merge/rollback instructions.

## Architecture (phase 1)

**Processes.** `qs -c pillbar` (systemd user unit `pillbar.service`, ordered before
plasmashell so it owns `org.freedesktop.Notifications`). The settings window is a separate
`qs -n -p …/settings.qml` process (`INIR_STANDALONE_WINDOW=1`) sharing the config file.
Long-lived children of the bar: `helpers/kwinir_bridge.py` (KWin bridge), `gdbus monitor`
×2 (KWin virtual desktops, Night Light), `nmcli monitor`, `wl-paste --watch cliphist store`.

**Entry points.** `shell.qml` → `PillBar` (per screen in `bar.screenList`),
`NotificationPopup` (only screens the pill doesn't cover — DP-3), `SidebarLeft`,
`SidebarRight`, a 1×1 idle-inhibit layer surface, the dual-sidebar backdrop, IPC handlers,
the cliphist watcher and service wake-ups (theme loader, KWin bridge, night light).
`settings.qml` → iNiR's settings window (`modules/settings/*`, 16 pages hidden via config).

**Code.** 604 QML/JS files: `modules/common` (200: Config, Appearance, Directories,
widgets), `modules/sidebarRight` (74), `services` (67 + `deferred` 15 + `ai` 9),
`modules/sidebarLeft` (66), `modules/settings` (52), `modules/pill` (48), plus upstream
families pulled in by the dependency closure (`overview`, `dashboard`, `iris`, `background`,
`barM3`, `bar`, `mediaControls`, `workspaceStrip`) that this port does not display.
110 singletons (qmldir). `helpers/` (Python bridge + KWin script), `scripts/keyring/`
(2 secret-tool lookups), `tools/`, `extras/` (unit, launchers, palettes), `defaults/`.

**Shared services/singletons (most used).** `Config` (JsonAdapter over
`~/.config/pillbar/config.json`, file-watched, debounced writes, broken-file guard,
`resetPath`), `Appearance` (tokens from `MaterialThemeLoader` ← static
`~/.local/state/quickshell/user/generated/colors.json`), `GlobalStates`, `Persistent`
(`states.json`), `CompositorService` (+ `KWinService` for virtual desktops), `Notifications`
(the notification server; history in `notifications.json`), `Audio` (Pipewire),
`MprisController`, `Network` (nmcli), `BluetoothStatus`, `Battery` (UPower), `Brightness`,
`Idle`, `GameMode`, `KWinBridge`, `Hyprsunset` (night light → KWin Night Light),
`Wallpapers`, `UserPalettes`, `Weather`, `Ai`, `AppCatalog`, `Cliphist`, `GlobalActions`.

**Data sources.** Quickshell services (Mpris, Pipewire, UPower, NotificationServer,
SystemTray, IdleInhibitor), KWin D-Bus (`/VirtualDesktopManager`, `/KWin`, `/Effects`,
`/Scripting`, `/org/kde/KWin/NightLight`), plasmashell scripting (wallpaper), nmcli,
bluetooth tooling, brightness (ddcutil/backlight), cliphist, HTTP APIs (weather, AI
providers, news, Wallhaven, anime, booru), files under `~/.config/pillbar`,
`~/.local/state/quickshell`, `~/.cache`.

**Config system.** One file, `~/.config/pillbar/config.json` (2,600+ options, defaults in
`Config.qml`); unparsable file → `.broken-<time>` copy, writes blocked; per-page and global
reset from `baseline.json` / `defaults/inir-factory-config.json`. Palette: static
`colors.json`, user palettes in `extras/theme/`. App/terminal theming is blocked in code.

**IPC** (Quickshell socket in `$XDG_RUNTIME_DIR`, same-user only): `sidebarLeft`,
`sidebarRight`, `settings`, `pill`, `palette`, `idle`, `gamemode`, `audio`, `brightness`,
`mpris`, `notifications`, `zoom`, `globalActions`, `dev`, `appCatalog`, `ai`, `autostart`,
`shellUpdate`, `shellLayout`, `voiceSearch`, `minimize`, `widgetpower`, `cliphistService`,
`packageSearch`, `keyboard` (niri), `ytmusic` (dropped). Several register only once their
(lazy) singleton exists.

**Shortcuts** (KDE global, launchers in `~/.local/share/applications/net.local.pillbar-*`):
Meta+Comma settings, Meta+Shift+Space right sidebar, Ctrl+Shift+Space left sidebar,
"Pill bar: peek" unbound.

**External commands.** 596 `Process`/`execDetached` sites (inventory:
`tools/audit-inventory.py`), 63 `bash -c` scripts built from templates or concatenation
(injection review list), 185 network-related lines, 60 repeating timers, 9 fixed `/tmp` paths.

## Baseline (before any audit change)

Measured with `tools/measure-idle.sh 60`, bar idle, bar process tree:

| State | CPU (one core) | RSS | PSS | Processes |
|---|---|---|---|---|
| fresh start, sidebars never opened | 0.07 % | 426 MB | 262 MB | 6 |
| after opening both sidebars once | 0.12 % | 680 MB | 500 MB | 6 |

## Checklist

| Area | Status |
|---|---|
| shell.qml, settings.qml, GlobalStates.qml | reviewed (warnings, children) |
| modules/common (Config, Appearance, Directories, Persistent, functions) | todo |
| modules/common/widgets | todo |
| modules/pill | todo |
| modules/sidebarLeft | todo |
| modules/sidebarRight | todo |
| modules/notificationPopup | todo |
| modules/settings | todo |
| services (core) | todo |
| services/deferred | todo |
| services/ai | todo |
| helpers (kwinir_bridge.py, kwinir-fullscreen.js) | todo |
| scripts/keyring | todo |
| upstream families not displayed (overview, dashboard, iris, background, barM3, bar, mediaControls, workspaceStrip) | todo (loaded-or-not check) |
| .gitignore / secrets / permissions | todo |

## Findings

Severity: **H** high, **M** medium, **L** low, **I** info. Status: open / fixed (commit) /
needs approval.

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| 1 | M | services/Ai.qml:959, services/ai/GeminiApiStrategy.qml:238 | AI request script and upload temp files at fixed `/tmp/quickshell/ai/*` paths; the request script is executed | open |
| 2 | L | services/YtMusic.qml:2043, services/WebWallpaper.qml:75, services/Brightness.qml:512, modules/common/Directories.qml:78,107,108 | other fixed `/tmp` paths (mpv socket, pid file, screenshots, images, cliphist decode) | open |
| 3 | L | services/GlobalActions.qml, other lazy singletons | IPC targets only exist after the singleton is created ("Target not found" for `globalActions` right after start) | open |
| 4 | I | shell.qml / sidebars | sidebars keep ~250 MB resident after first open (upstream "resume where you left off") | needs approval |
| 5 | L | services/AppLauncher.qml:199 | browser preset in settings also runs `xdg-settings set default-web-browser` (system setting) | needs approval |
| 6 | L | settings process | Quick page instantiates the notification server in the settings process, which retries registration if the bar's server disappears | open |
| 7 | M | shell.qml, services/KWinService.qml, Hyprsunset.qml, Network.qml, deferred/CavaService.qml | long-running children (clipboard watcher, 2× gdbus monitor, nmcli monitor, cava) orphaned when the bar is killed/crashes — 48 monitors + 6 clipboard watchers had piled up; orphaned watchers kept recording clipboard history after it was switched off | fixed `6ef15c1` (setpriv --pdeathsig) |
| 8 | L | services/Network.qml:227 | upstream runs `pkill -f "nmcli monitor"` at start to clear its own orphans — also kills any `nmcli monitor` the user runs elsewhere; unnecessary now (#7) | needs approval (remove) |
| 9 | I | ~/.config/pillbar/avatar.svg (user file) | 2× "qt.svg: Invalid path data" per load; renders fine | needs approval (clean the SVG) |
| 10 | L | modules/common/Directories.qml:73 | optional AccountsService avatar watcher logged "does not exist" every start | fixed `5cf6878` |
| 11 | L | services/CustomWidgets.qml:44 | Monitors page ran the unshipped scan-widgets.sh ("Process failed to start") | fixed `3116dcd` |
| 12 | M | services/CustomWidgets.qml:227,403 | widget create/remove build `rm -rf "…/${widgetId}"` shell strings from a name (injection pattern); only reachable from the hidden Desktop Widgets page | open (phase 4) |

(Fixed before the audit began, for the record: Gowall `/tmp` PATH shims `104f6fb`, pill
toast rich text `9be3225`, theming guards `6c5ed14`.)

## Needs approval

(See findings marked "needs approval"; recommendations are added in phase 5.)

## Log

- `audit` branched from `main` at `d710009` (clean tree, no snapshot commit needed).
- Phase 2 warnings pass: live journal since 12:00 aggregated; staging run driving both sidebars,
  4 left tabs and all 12 pill surfaces over IPC (24 calls, all reached the bar); all 60
  settings page/sections rendered via `_harness.qml`. Result: no QML warnings left except the
  user's avatar SVG (#9). Stale warnings (pre-15:04 missing assets, `imgStatus` loop,
  `mocha.jpg` test file, broken-config test) confirmed gone. `5cf6878`, `3116dcd`.
- Hot-reload/kill test found orphaned children (#7) — fixed `6ef15c1`, 54 test leftovers
  killed. (A plain `touch` doesn't trigger a Quickshell reload; content must change.)
