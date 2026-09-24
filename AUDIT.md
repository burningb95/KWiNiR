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

Phase 4, remaining: (2) rich text — grep `textFormat` / `Text.RichText` / `StyledText` /
`Text.MarkdownText` in notification, media, AI and tooltip views; check remote images can't
load; (3) IPC surface — every target's functions, flag command execution / secret reads;
(4) secrets — AI/weather keys, `.gitignore`, `~/.config/pillbar` permissions; (5) network —
HTTPS-only (ip-api.com is plain HTTP: Weather.qml:866), timeouts, failure handling;
(6) temp files — #1, #2.

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

## After phase 3

`tools/measure-idle.sh 90` now also counts **short-lived children** (reaped `gdbus`/`pgrep`
spawns: kernel `cutime`/`cstime`), which the baseline couldn't see. With them included, the
real pre-phase-3 cost was **0.50 %** fresh (0.12 % bar + 0.38 % spawns).

| State | CPU incl. children, before → after | RSS | PSS | Processes |
|---|---|---|---|---|
| fresh start, sidebars never opened | 0.50 % → **0.04 %** | 429 MB | 268 MB | 6 |
| after opening both sidebars once | ~0.30 % → **0.09 %** | 674 MB | 499 MB | 6 |

Memory unchanged (sidebar content stays resident after first open — #4, needs approval).
Idle process spawns: ~36/min → **0** (bridge polls in-process; recorder/EasyEffects polls gone).

**Repeating timers that stay (justified):** `Ame.qml` 83/33 ms — the pill's idle breathing
animation (animation values are off-limits; it is the motion the port exists for); DateTime
60 s and Weather 60 s clock ticks (in-process, no I/O beyond `/proc/uptime`); KWin
output/overview 5 s — KWin has **no change signal** for either (verified by introspection),
now polled in the bridge without spawning; KWinService's own gdbus poll only as fallback;
Weather fetch 10 min, Updates 120 min (network by nature). Everything else in the displayed
modules is gated on its surface being open (sidebar/pill popups) or on a feature being on.

## Checklist

| Area | Status |
|---|---|
| shell.qml, settings.qml, GlobalStates.qml | reviewed (warnings, children, IPC) |
| phase 3 efficiency: timers, spawns, closed-sidebar work, images | reviewed / fixed |
| phase 2 robustness: Battery, BluetoothStatus, Audio, MprisController, Network, KWinService, Hyprsunset, Config | reviewed / fixed |
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
| 3 | L | services/GlobalActions.qml, other lazy singletons | IPC targets only exist after the singleton is created. 11 lazy at start: ai, appCatalog, autostart, cliphistService, packageSearch, dev, globalActions, minimize, shellUpdate, voiceSearch, widgetpower — none bound to a hotkey | needs approval — recommend **leave**: waking them would start iNiR's Autostart and ShellUpdates services |
| 4 | I | shell.qml / sidebars | sidebars keep ~250 MB resident after first open (upstream "resume where you left off") | needs approval |
| 5 | L | services/AppLauncher.qml:199 | browser preset in settings also runs `xdg-settings set default-web-browser` (system setting) | needs approval |
| 6 | L | settings process | Quick page instantiates the notification server in the settings process, which retries registration if the bar's server disappears | open |
| 7 | M | shell.qml, services/KWinService.qml, Hyprsunset.qml, Network.qml, deferred/CavaService.qml | long-running children (clipboard watcher, 2× gdbus monitor, nmcli monitor, cava) orphaned when the bar is killed/crashes — 48 monitors + 6 clipboard watchers had piled up; orphaned watchers kept recording clipboard history after it was switched off | fixed `6ef15c1` (setpriv --pdeathsig) |
| 8 | L | services/Network.qml:227 | upstream runs `pkill -f "nmcli monitor"` at start to clear its own orphans — also kills any `nmcli monitor` the user runs elsewhere; unnecessary now (#7). **Seen in practice 2026-09-24:** it matches any command line containing that text and killed the audit's own shell during a promote | needs approval (remove) |
| 9 | I | ~/.config/pillbar/avatar.svg (user file) | 2× "qt.svg: Invalid path data" per load; renders fine | needs approval (clean the SVG) |
| 10 | L | modules/common/Directories.qml:73 | optional AccountsService avatar watcher logged "does not exist" every start | fixed `5cf6878` |
| 11 | L | services/CustomWidgets.qml:44 | Monitors page ran the unshipped scan-widgets.sh ("Process failed to start") | fixed `3116dcd` |
| 13 | M | services/KWinService.qml | KWin signal monitor (`gdbus monitor`) never restarted if it exited — workspace dots froze until the bar restarted | fixed `a690406` (restart after 2 s + refresh; kill test on staging) |
| 14 | M | services/Network.qml:238 | nmcli monitor restarted instantly on exit; with an nmcli that fails at once it respawned ~250×/s (staging, fake failing nmcli: 2957 launches in 12 s → 10 after) | fixed `f5daecc` (1 s delay) |
| 15 | M | services/YtMusic.qml:106 | `onAudioQualityChanged` wrote the config value it is bound to back to Config, so **every bar start rewrote `config.json`** (same values, different formatting; a write that can race external edits). Found by the config fault-injection test | fixed `93d75c7` (write only when different; verified byte-identical after restart) |
| 16 | I | modules/pill/Pill.qml, JsonAdapter | config robustness: wrong types, junk list items, >4 dividers, deleted sections and unknown keys all fall back without a crash (warnings only); rowOrder never drops items | no action |
| 17 | L | services/Hyprsunset.qml:195 | a non-numeric `light.night.colorTemperature` becomes 0 → clamped to 1000 K (very red) rather than the default | needs approval (fall back to default when < 1000); not runtime-tested — it would write kwinrc |
| 18 | M | services/RecorderStatus.qml:138 | `pgrep -xo wf-recorder` every 5 s at idle; wf-recorder can't run on KWin (no wlr-screencopy — verified, it exits at once) and the pill records with Spectacle | fixed `e5bf95f` (poll off on KWin) |
| 19 | M | services/deferred/EasyEffects.qml:212 | after the right sidebar's first open, `pgrep -x easyeffects` every 5 s for the rest of the session | fixed `62350c3` (poll only while the right sidebar is open, check on open) |
| 20 | M | services/KWinService.qml:217 | 2 `gdbus call` spawns every 5 s (focused output + overview) — 0.38 % of a core, 3× the bar's own idle cost | fixed `3915a19` (same 5 s poll inside the bridge helper, reported every poll; gdbus poll kept as fallback; kill-test verified) |
| 21 | M | modules/sidebarLeft/widgets/StatusRings.qml:14 | the left sidebar's window stays mapped when closed, so the CPU/RAM rings kept ResourceUsage polling `/proc` every 3 s forever after the first open | fixed `66b4b47` (monitor gated on `sidebarLeftOpen`; 15 s auto-stop verified) |
| 22 | I | modules/pill/Ame.qml:332 | the pill's idle animation repaints its canvas 12×/s whenever the pill is visible, including under fullscreen windows | needs approval — optional: pause while game mode / a fullscreen window is up (changes nothing you'd see) |
| 12 | M | services/CustomWidgets.qml:227,403 | widget create/remove build `rm -rf "…/${widgetId}"` shell strings from a name (injection pattern; `..` would delete the widgets folder's parent); only reachable from the hidden Desktop Widgets page | fixed `aa4d998` (ids limited to `[A-Za-z0-9_-]`, rm target as argument) |
| 23 | **H** | services/Wallpapers.qml:1113 | thumbnail command quoted paths with `JSON.stringify` (double quotes: `$(…)` still expands) — a wallpaper **file name** ran commands (reproduced in a scratch dir) | fixed `f2f1295` |
| 24 | M | services/Weather.qml:552 | wttr.in URL in a single-quoted shell string; `encodeURIComponent` leaves `'` alone; city can come from an IP-lookup reply | fixed `4d601c6` (argv) |
| 25 | M | modules/common/widgets/Favicon.qml:32 | AI search-source display text used as "domain": unquoted in the script and in the cache path | fixed `3a7c208` |
| 26 | M | modules/sidebarLeft/anime/BooruImage.qml:94,266,281 | API-reply URLs in single-quoted bash (×3) **and path traversal**: file name URL-decoded from the reply (`%2F` → `../../.bashrc`) | fixed `b9d3150` (tab hidden for you: `policies.weeb 0`) |
| 27 | M | modules/sidebarLeft/aiChat/MessageCodeBlock.qml:103 | AI code-fence language tag unescaped in the save path | fixed `9e7e70b` |
| 28 | L | WorldClockWidget.qml:99, settings/InterfaceConfig.qml:1459 | configured timezones spliced into a script (config input) | fixed `66f923c` (identical output, diffed) |
| 29 | L | modules/common/ThemePresets.qml:3905 | palette files written by single-quoting JSON ("JSON has no single quotes" — false for string values): an apostrophe in a theme/palette name broke the write or ran as shell | fixed `0b4f25f` |
| 30 | I | services/Ai.qml:1672 | AI `run_shell_command` runs model-chosen bash — **not offered** with your `ai.tool: functions`, and every raw command waits for your Approve click | no action |

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
- 2026-09-24: first login after 09-23 showed a second bar + the retired neon sidebar running
  (`.desktop.disabled` autostarts still launched by systemd's generator) — fixed outside the
  repo (entries moved to `~/.local/share/Fancy-Floating-Bar/autostart-disabled/`, see STATE.md).
  Meta+Comma was owned by Latte ("Activate Entry 18"); burningb95 cleared Latte's binding.
- Phase 2a (missing data) by code review + staging tests: Battery (all gated on
  `available`, false on this desktop), BluetoothStatus and sidebar BT dialogs (optional
  chaining / early return), Audio (optional chaining on sink/source), MprisController
  (`activePlayer &&` guards) — no issues. Monitors: Hyprsunset, clipboard watcher and cava
  restart themselves; KWinService didn't (#13), Network spun (#14).
- Phase 2b (config robustness), staging, 7 injected faults on a backup-restored config
  (backup `~/.local/share/Fancy-Floating-Bar/config.json.bak-before-audit-cfgtest-1790257193`):
  rowOrder string / junk / 7 dividers, candy wrong types, hiddenTypes=42 (right sidebar opened),
  jobProgress string, shellLayout string, deleted `sidebar` + unknown key → survived, warnings
  only (#16). Found the startup config rewrite (#15). Config restored **byte-identical**.
  Night-light values not injected (would write kwinrc) → code review (#17).
- Phase 2c (races/environment): 11 lazy IPC targets (#3). Unit has `Restart=on-failure`; the bar
  gets `QT_WAYLAND_RECONNECT=1` like plasmashell. Not exercised (would disrupt the session):
  KWin crash, plasmashell restart, sleep/resume, monitor hotplug — code review only; monitors
  now all self-restart (#13, #14), screens come from Quickshell `Variants` + `screenList`.
- Phase 3: spawn sampler (`/proc` every 20 ms) + reaped-CPU measurement found the idle spawns
  (#18, #20) and the post-sidebar pollers (#19, #21, bisected right vs left sidebar on staging).
  Infinite animations in both sidebars are already gated on `sidebar*Open`. Left sidebar
  banner: screen-sized async decode, released on close — fine.
- Phase 4 (1) shell strings: all 64 `bash -c`/`sh -c` sites from the inventory read. Safe as-is:
  positional-argument scripts (GlobalStates, MediaArtworkResolver, Hyprsunset, GameMode,
  UserPalettes, WebWallpaper, ResourceUsage, PillSysmon, CustomWidgets scan), fixed text
  (AppCatalog, PillLink, MprisController probe), properly escaped (Brightness, Cliphist —
  ids are digits-only, CliphistImage, AiChat, CustomThemeEditor, Gowall `_shellEscape`),
  constants (LinkWifi hotspot name). ShellUpdates (disabled in config) and ScreenTime
  (skipped by you) not reviewed in depth. Fixed #12, #23–#29.
- Hot-reload/kill test found orphaned children (#7) — fixed `6ef15c1`, 54 test leftovers
  killed. (A plain `touch` doesn't trigger a Quickshell reload; content must change.)
