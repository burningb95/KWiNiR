# iNiR Material ii pill bar — KWin port

Extracted from the iNiR git checkout at `~/.local/share/inir`
(**v2.31.0, commit 9574fa42**) on 2026-09-23. The original checkout is untouched.

Entry: `shell.qml` -> `modules/pill/PillBar.qml`. Run with `qs -c pillbar`.

## Why PillBar

Your config selected it: `panelFamily = "ii"`, `bar.appearanceStyle = "pill"`,
`appearance.globalStyle = "material"`, `bar.bottom = false`, `bar.vertical = false`.
Upstream routes that combination at `modules/ii/critical/ShellIiCriticalPanels.qml:32`.
`modules/bar/` (classic ii) and `modules/barM3/` are different bars and are not included.

## 109 files, copied verbatim (bar)

Timing and animation files were copied with **zero edits**, including:

- `modules/pill/Ame.qml` — 飴 Ame, the "dot jump" indicator. Quadratic-bezier
  flight with tapered streak, anticipation stretch, remnant droplet pinch-off,
  three-droplet landing splash, easeOutBack settle.
- `modules/pill/PillMotion.qml` — the whole timing authority:
  `fast 140 / standard 300 / morph 420 / shapeshift 820 / glide 260 / heat 1100 /
  pulse 420`, `easeStandard OutCubic`, `morphCurve cubic-bezier(0.16, 1, 0.3, 1)`.
- `modules/pill/Pill.qml`, `PillSurface.qml`, and every `Pill*` surface.

The 8 `qmldir` files were regenerated, trimmed to the copied components only,
because the originals declare components that were not copied.

## The 7 rewired sites

`CompositorService` gained an `isKWin` branch beside the existing Hyprland and
niri ones. Nothing was forked.

| File | Change |
|---|---|
| `services/KWinService.qml` | **new** — KWin backend (see below) |
| `services/CompositorService.qml` | `isKWin` property, KWin detection, DPMS routing |
| `modules/pill/PillWorkspaces.qml` | KWin branch in `slots`, `hyprActiveId` short-circuit, `focusSlot` routing |
| `modules/pill/PillBar.qml` | `focusedScreenName()`, `overviewOwnsEdge` |
| `services/Brightness.qml` | focused-output lookup (both directions) |
| `GlobalStates.qml` | `focusedScreen` |
| `modules/common/Directories.qml` | `shellConfig` -> `~/.config/pillbar` for isolation |

Upstream's detection left both compositor flags false on KWin, which sent
workspace consumers down the Hyprland branch and produced an empty dot row.

## niri -> KWin data mapping

| Need | KWin replacement |
|---|---|
| workspace list | `org.kde.KWin /VirtualDesktopManager` `desktops` / `count` / `current` + signals |
| switch workspace | `org.kde.KWin.setCurrentDesktop(int)` |
| focused output | `org.kde.KWin.activeOutputName()` |
| monitor DPMS | `kscreen-doctor --dpms off/on` |
| overview open | polled from `/Effects activeEffects` containing `overview` (best effort) |

Quickshell 0.3.1 exposes no generic D-Bus client to QML, so `KWinService` shells
out via `gdbus`, the same way `NiriService` shells out to `niri msg`. State is
event-driven: `gdbus monitor` streams `VirtualDesktopManager` signals. Only
`currentOutput` and overview state use a 5s timer, because KWin emits no signal
when focus moves between monitors.

## Dropped, with reasons

- **Per-output workspaces.** KWin virtual desktops are global, so every monitor
  shows the same dots with the same active one. niri gave each output its own
  set. Not replicable — `PillWorkspaces`' output filter is skipped on KWin.
- **niri's scrollable-workspace visualization.** No KWin equivalent; dots are a
  fixed row matching the desktop count.
- **Overview hot corner** (`isOverviewHotCornerActive`). KWin electric-border
  hover state is not queryable. Returns `false`.
- **Fullscreen-window detection for game mode.** KWin supports no
  foreign-toplevel protocol, so Quickshell has no window list. Upstream already
  returns `false` off niri, so game-mode auto-trigger no-ops; manual still works.
- **Disabling compositor animations in game mode.** Possible via kwinrc
  `AnimationDurationFactor`, deliberately not done because it changes KWin
  globally.

## Theming: static, by choice

Colors come from a fixed `~/.local/state/quickshell/user/generated/colors.json`,
seeded from the palette your live iNiR session generated (69 Material 3 tokens,
`primary #9ac3c5`, `surface #3f3f3f` — the Material-adapted **Zenburn** palette).

**Correction (2026-09-23).** The first version of this port claimed the bar showed
that palette. It did not: screenshots showed saturated blue on navy, i.e.
`Appearance`'s built-in defaults. Two causes, both now fixed:

1. `appearance.theme` was `"zenburn"`, a *named preset*. `MaterialThemeLoader`
   only applies `colors.json` in `"auto"` mode; presets are applied by running
   `switchwall.sh` / `applycolor.sh` / `system24_palette.sh`, which are excluded
   from this tree by design, so preset mode can never work here. Set to `"auto"`
   in `~/.config/pillbar/config.json` (backup beside it:
   `config.json.bak-before-theme-auto`). The seeded file already *is* Zenburn.
2. `MaterialThemeLoader` is a lazily created singleton and nothing in the bar
   touched it, so it never ran. `shell.qml` now calls
   `MaterialThemeLoader.reapplyTheme()` once `Config.ready`. Upstream instead calls
   `ThemeService.applyCurrentTheme()` (runs `switchwall.sh` for "full
   regeneration … includes terminals, GTK, etc") and
   `IconThemeService.ensureInitialized()`. **Neither is called here.**

Verified visually after the fix: grey surfaces, teal toggles, mauve secondary.

**This bar cannot reskin the system.** iNiR's theming engine lives in
`scripts/colors/` (`switchwall.sh`, `applycolor.sh`), which was deliberately not
copied. `Directories.scriptsPath` is `Quickshell.shellPath("scripts")`, resolving
to `~/.config/quickshell/pillbar/scripts/` — a path that does not exist. That is
no longer the only barrier: `MaterialThemeLoader.defaultApplyExternal` is now
hard-coded `false` (upstream keyed it to `INIR_STANDALONE_WINDOW`), so the hook
that runs `applycolor.sh` never fires. Verified by grep: no writes to kdeglobals,
GTK/Qt settings, matugen, `plasma-apply-*`, `kwriteconfig`, Konsole, Fish or SDDM
anywhere in the tree.

## Sidebars (added 2026-09-23)

**Both** iNiR sidebars run in the bar's process, on **DP-1 only**
(`sidebar.screenList: ["DP-1"]`, already in your saved config):

- **Left** — iNiR's feature sidebar: Widgets / Wallpapers / News tabs, clock,
  weather, week strip, quick toggles, CPU/RAM rings, Quick Note, AI chat, anime,
  translator, Wallhaven. **Replaces the Garuda Neon Sidebar**, which is retired
  (autostart renamed to `.desktop.disabled`; code kept as a style reference). Opens
  on the Widgets tab; opening it makes no network requests — AI chat, News and the
  booru views only do when you use them (AI chat sends to Gemini/Mistral with keys).
- **Right** — iNiR's control center: quick toggles, sliders, network, bluetooth,
  calendar, notifications, pomodoro, notepad.

Both pill sidebar buttons work. Or bind **KWin custom shortcuts**
(System Settings → Shortcuts → Custom):

    qs -c pillbar ipc call sidebarLeft toggle
    qs -c pillbar ipc call sidebarRight toggle
    qs -c pillbar ipc call idle toggle          # caffeine

Upstream binds these through `Quickshell.Hyprland` `GlobalShortcut`, which rides
Hyprland's own global-shortcuts protocol and cannot work on KWin.

**They must share this process with the bar.** The pill's buttons call
`GlobalStates.toggleSidebarLeft/Right()`, and `GlobalStates` is an in-process
singleton.

### What was added

- **303 files**, copied verbatim (combined closure with the bar: 411 files,
  `MANIFEST-sidebar.txt` in the project dir). `SidebarHost.qml` declares all three
  content types as `Component`s, so either sidebar needs the other's code to
  compile; only the selected one is instantiated by a `Loader`.
- From the ii host (`ShellIiPanelsImpl.qml`), lifted verbatim into `shell.qml`: the
  **click-outside backdrop** (upstream only auto-closes on Hyprland via
  `CompositorFocusGrab`; every other compositor uses this catcher) and the
  **`sidebarLeft` / `sidebarRight` IPC handlers** from upstream `shell.qml`.

### Patches for this

| File | Change |
|---|---|
| `GlobalStates.qml` | **Upstream bugfix, not KWin-specific:** `connectedOutputNames()` guarded with `Array.isArray(allowedOutputs)`, but Config screen lists are QML `list<string>` — under Qt 6 a sequence, not a JS array — so **every `screenList` was silently ignored** and sidebars opened on whichever monitor had focus. Now normalized with `Array.from()`. Proven independent of focus: asking for DP-3 now falls back to DP-1. |
| `services/ShellLayoutController.qml` | Same upstream bug in `_outputEnabled()`, which decides which monitors reserve layout space for the bar and dock: `bar.screenList` was ignored. Same `Array.from()` fix. |
| `services/Idle.qml` | **never start `swayidle` on KWin.** Upstream spawns it with lock, screen-off and `systemctl suspend` timeouts. KWin implements `ext_idle_notifier_v1`, so it would genuinely fire in parallel with Plasma's PowerDevil — including suspend once `idle.suspendTimeout` is non-zero. |
| `services/MaterialThemeLoader.qml` | `defaultApplyExternal: false` (see Theming) |
| `shell.qml` | wake `MaterialThemeLoader`; backdrop; IPC handlers; **caffeine** (below) |

### Caffeine (works)

Every idle toggle — both quick-toggle styles and the left sidebar's tools view —
flips `Idle.inhibit`, which upstream only used to stop its own `swayidle`. On KWin,
`shell.qml` now binds a Wayland `IdleInhibitor` (`zwp_idle_inhibit_manager_v1`, the
protocol PowerDevil honors — same as video players) to `Idle.inhibit`, hung off a
1×1 transparent, click-through layer surface. Also exposed as `ipc call idle
toggle|on|off|state` (a KWin-port addition; upstream has no idle IPC).

Verified with an isolated `swayidle -w timeout 3 'echo IDLE'` harness, in both
orders: caffeine off → `IDLE` after 3 s; on → nothing over 8 s.

### Limitations on KWin

- **Night light toggle does nothing** (upstream uses `hyprsunset`/`wlsunset`; KWin has
  no `wlr-gamma-control`). KWin's own Night Light is on D-Bus at
  `/org/kde/KWin/NightLight`; turning it on means writing `kwinrc [NightColor]`.
  Deferred.
- **Settings button is dead** — iNiR's `settings.qml` isn't extracted. Deferred.
- **Screen time** has no per-app data (no window list on KWin). Won't fix.
- **Reload button** runs `Hyprland.dispatch`/`niri msg` and a missing
  `scripts/restart-shell.sh`; harmless no-op.
- **Context menus** don't auto-close on focus loss (niri/Hyprland-only paths).
- ~~DP-3 unsupported~~ — **was the `screenList` bug above**, not a portrait-monitor
  problem. Earlier runs appeared to flip between DP-1 and DP-3 because resolution
  followed whichever monitor had focus at the time.

## Notifications: iNiR owns them (2026-09-23)

The bar is the session's `org.freedesktop.Notifications` server; Plasma's popups,
history and DND are replaced by iNiR's. Plasma's `NotificationManager::Server` yields
when the name is already owned, so the bar only has to register **first**:

- Runs as the systemd user unit `~/.config/systemd/user/pillbar.service`
  (`WantedBy=plasma-core.target`, `After=plasma-kwin_wayland.service`,
  `Before=plasma-plasmashell.service`). Its `ExecStartPost` holds plasmashell back until
  the bar actually owns the name (≤10 s, always succeeds). This **replaces** the XDG
  autostart entry, now `~/.config/autostart/pillbar.desktop.disabled`.
- Popups: the pill shows notifications as **toasts** on its own screen (DP-1,
  `bar.pill.toasts`); iNiR's standalone `NotificationPopup` covers the other
  notification screens (DP-3). Rule lifted verbatim from `ShellIiPanelsImpl.qml` into
  `shell.qml`; `modules/notificationPopup/` added (1 file).
- Verified: after a plasmashell restart the bar keeps the name; `notify-send` produces a
  pill toast and an entry in the right sidebar's list.
- **Lost:** file-transfer progress (Dolphin copies, downloads) — Plasma shows it via
  `org.kde.JobViewServer` inside its notification UI, and iNiR has no equivalent.
- Stop/start with `systemctl --user stop|start pillbar`. If the bar is stopped while
  Plasma runs, Plasma *could* reclaim the name (it didn't in testing); restarting
  plasmashell hands it back.

## Softer active controls (2026-09-23)

Active quick toggles (`AndroidQuickToggleButton.qml`) and slider fills
(`StyledSlider.qml`) use `colPrimaryContainer` (deep red `#5c0a1f`) with
`colOnPrimaryContainer` icons instead of neon `colPrimary` — burningb95 found the solid
neon fills too loud. Slider handles and text accents keep neon red. This mirrors
upstream's own "inir" style, which already fills toggles with the container color.

## Palette: your Garuda Neon Sidebar

Since 2026-09-23 the colors come from the neon sidebar's `code/Theme.qml`, mapped
onto iNiR's Material 3 roles. Source copies: `theme/colors.neon.json` and
`theme/colors.zenburn.json` in the project dir; the live file is
`~/.local/state/quickshell/user/generated/colors.json` (Zenburn backup beside it as
`colors.zenburn.json`).

| M3 role | Color | Neon token |
|---|---|---|
| background / surface | `#0b080d` | `background` |
| surface_container_low (layer-1 boxes) | `#120d16` | `panel` |
| surface_container (layer-2 boxes) | `#1b1220` | `card` |
| surface_container_high | `#24162b` | `cardHover` |
| outline_variant | `#39233f` | `borderColor` |
| on_surface / on_surface_variant | `#f4edf5` / `#aa9cac` | text primary / secondary |
| primary | `#ff1744` | `neonRed` |
| secondary | `#ff2bd6` | `neonPink` |
| tertiary | `#00eaff` | `neonCyan` |
| error | `#ffb4ab` | *(standard M3, so errors don't read as the accent)* |

Transparency (`appearance.transparency` in `~/.config/pillbar/config.json`):
`enable: true`, `automatic: false`, `backgroundTransparency: 0.15` (the neon panel's
85% opacity), `contentTransparency: 0` (boxes opaque, as in the neon sidebar).


## Uninstall

`~/.local/share/Fancy-Floating-Bar/REVERT-pillbar.sh`

## Assets and avatar (KWin port)

`assets/icons` and `assets/images` are copied verbatim from upstream (the closure tool
follows imports, so image folders were missed at first — the distro icon was blank).
`assets/wallpapers` (42 MB) is deliberately not included.

The right sidebar's avatar is read first from `~/.config/pillbar/avatar` (any image
format — `avatar.png`, `avatar.jpg`; Qt probes the suffix), a bar-only path added in
`modules/common/Directories.qml`. Upstream's fallbacks follow: the AccountsService icon,
`~/.face`, `~/.face.icon` — those are the account picture Plasma and SDDM show, so they
are left alone. Restart the bar after replacing the image.
