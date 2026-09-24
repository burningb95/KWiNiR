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

## Settings window (KWin port)

iNiR's standalone settings window (`settings.qml`, 173 extra files) runs as its own
process, `qs -n -p ~/.config/quickshell/pillbar/settings.qml`, sharing this tree's
Config. Open it from the right sidebar's settings button or
`qs -c pillbar ipc call settings toggle` (also `open`, `openWindowAt <page>`).
`GlobalStates._kwinSettingsWindow()` replaces upstream's `scripts/inir settings-window`.

Safety patches (audit of every command the closure can run):

- **`IconThemeService.systemWritesAllowed: false`.** Upstream's icon picker — and even
  *opening* its dropdown, which restores `appearance.iconTheme` — runs gsettings,
  rewrites `kdeglobals [Icons]` (by hand and via kwriteconfig6), qt5ct, qt6ct and GTK
  `settings.ini`, all by absolute path. The missing `scripts/` did not block this.
  The Themes page's Icon Theme card is also never loaded.
- **`ShellUpdates.enabled: false`.** It git-fetches the shell's own tree and offers to run
  iNiR's installer.
- Color theming needs no new patch: every external-apply path funnels into
  `MaterialThemeLoader._applyExternalTheming()` (hard-disabled) and `scripts/`.
  Picking a color preset *does* overwrite the bar's own `colors.json`; the neon palette
  is in `extras/theme/colors.neon.json`.
- `settings.qml`: lock button → `Session.lock()`, config-file button →
  `~/.config/pillbar/config.json`, overlay button hidden (overlay not extracted).

Pages that do nothing on KWin are hidden through upstream's own navigation config
(`settingsUi.categories` → `hidden`), editable in the window via *Edit navigation*.
Buttons that call `scripts/` (wallpaper regeneration, screenshot tools, niri
config) silently do nothing.

## Icon theme (KWin port)

The bar and the settings window draw app icons (tray, launcher, notifications, media
players, mixer) in **candy-icons** via `//@ pragma IconTheme candy-icons` in `shell.qml`
and `settings.qml`. The pragma sets Qt's icon theme for that process only; the desktop
keeps BeautyLine. Missing icons fall back through candy's `Inherits=` (breeze-dark,
Adwaita, hicolor). UI glyphs are the Material Symbols font and are unaffected.

### Candy status icons and palette

The pill's four status indicators — wifi signal, battery, inbox bell, media
volume/playback — use candy-icons `status/` icons through `modules/pill/CandyStatusIcon.qml`
instead of the hand-drawn `WifiGlyph`/`GlyphIcon`. Candy icons carry their own gradient
colors, so the idle→hover tint becomes opacity (0.82 → 1, `PillMotion.fast`). The
bell's ringing state replaces upstream's unread dot. Tool buttons and Material Symbols
elsewhere are unchanged: candy has no action icons, and those glyphs animate fill/weight.

Palette: `extras/theme/colors.candy.json` is the neon palette with secondary nudged to
candy magenta-violet (`#d63bff`) and tertiary to candy cyan-blue (`#1ec8ff`); primary
stays neon red. `colors.neon.json` is the previous version.

### Hand-picked glyphs (CandyGlyphs)

`modules/common/CandyGlyphs.qml` maps specific Material Symbols to burningb95's chosen
SVGs in `assets/candy/` (sources and licenses in its `CREDITS.md`); `MaterialSymbol.qml`
draws the SVG instead of the font glyph when a name is mapped. Mapped everywhere:
`delete_sweep` (clear), `do_not_disturb_on` / `notifications_paused` (DND), `gamepad` /
`sports_esports` (game mode), `calendar_month`, `calculate`, `search`, `hourglass_empty`
(timer), `checklist` (todo). Generic names get an explicit `"candy:<id>"` at the call
site instead — the right sidebar's timer tab (`schedule`), to-do tab (`done_outline`), and
the three dark-mode toggles (`dark_mode`/`contrast`, `candy:dark-mode`; `dark_mode` is also
a night marker in clocks, so it isn't mapped globally). Current picks: clear = bleachbit,
DND = umbrello, dark mode = stellarium, to-do = gnome-todo (see `assets/candy/CREDITS.md`).
Add a pick: drop the SVG in `assets/candy/`, add it to `files` and `materialMap`.

Palette since 2026-09-23 (late): `extras/theme/colors.plum.json` — primary neon plum
`#d4209e`, secondary deep red `#d0142f`, tertiary candy cyan-blue.

### Candy everywhere (material-map.json)

`assets/candy/material-map.json` maps ~310 Material Symbols names to candy-icons files
(or `@pick` hand picks); `CandyGlyphs` loads it synchronously and watches it, so edits
apply live. Generated by `tools/candy_map.py` from a curated table, then pruned by hand —
**delete a line to give that glyph back to Material Symbols.** Not mapped, by design:
actions (close, add, check, arrows, edit, refresh — candy has no action set), weather
conditions (none in candy), and AI glyphs (candy's only candidate is Qt Assistant's logo).
The pill's own `GlyphIcon` drawings get the same treatment through `"pill:<glyph>"` keys
(transport controls, chevrons, close/check/trash, sidebar toggles and weather stay drawn);
their idle/hover tint becomes opacity.

## Customization backbone (phase 2, 2026-09-23)

Every new option defaults to the previous behavior. Full list in commit `19610a4`.

| Option / change | Notes |
|---|---|
| Config broken-file guard | unparsable `config.json` → copied to `.broken-<time>`, writes blocked, notification; fix the file and it reloads |
| `Config.resetPath(prefix, "baseline"\|"factory")` | baseline = `~/.config/pillbar/baseline.json`; factory = `defaults/inir-factory-config.json` (`tools/dump-factory-config.sh`) |
| `bar.pill.rowOrder` | hover-row order, `"|"` = divider; applied live |
| `bar.autoHide.peek` + `ipc call pill peek` | KWin stand-in for Super-hold (Hyprland-only upstream) |
| `clipboard.historyWatcher` | the bar runs `wl-paste --watch cliphist store` |
| `gameMode.kwinEffects` | unloaded for the session while game mode is on, never written to kwinrc |
| `sidebar.quickToggles.hiddenTypes` | default `["cloudflareWarp"]` (warp-cli not installed) |
| `sidebar.right.avatarPath` | `""` = `~/.config/pillbar/avatar` |
| `appearance.candy.*`, `appearance.userPalette` + `ipc call palette apply <name>` | palettes live in `extras/theme/colors.<name>.json` |
| Screen snip, Tools tab capture/record/OCR | Spectacle (+ tesseract for OCR) |
| Wallpaper apply | Plasma scripting, originals saved; `tools/restore-plasma-wallpaper.sh` |
| Pill recorder surface | Start runs `spectacle -R region\|screen`; Spectacle owns stop + audio, so the audio chip is hidden on KWin |

### Files the extraction had missed (fixed 2026-09-23)

`closure.py` skipped 2-character identifiers (the `Ai` singleton) and never
followed `.json` data or `shellPath("defaults/...")`. Result: the AI tab threw
`Ai is not defined`, the Software tab sat on "Loading catalog...", and settings
search had no index. Copied verbatim: `services/Ai.qml`, `services/ai/*`,
`ObjectUtils.qml`, `defaults/ai/prompts/`, `defaults/app-catalog.json`,
`modules/settings/settings-search-index.generated.json`.

`scripts/` now exists but holds **only** `keyring/try_lookup.sh` and
`keyring/is_unlocked.sh` (secret-tool lookups for AI API keys, against the
running gnome-keyring). `keyring/unlock.sh` restarts gnome-keyring-daemon and is
deliberately absent; so is everything else in upstream `scripts/`.

Left-tab status on KWin: AI works (needs a provider key), Translator works
(`trans`), Software works (pacman + paru; installs open `apps.terminal`, which
is `kitty`), Tools works. YT Music needs `innertube-runtime.sh`/`innertube.py`
and `python-ytmusicapi` (not installed) — pending a decision. Web Apps
(plugins) is commented out upstream and has no tab.

## Settings pages (phase 3, 2026-09-23)

Each page is ported one at a time and waits for burningb95's OK. All use the
theme tokens (`Appearance.colors.*`) and upstream's own widgets; every page gets
a `PageResetFooter` (two clicks; "my setup" = `~/.config/pillbar/baseline.json`,
"iNiR defaults" = `defaults/inir-factory-config.json`).

| Page | Where | What it adds | Commit |
|---|---|---|---|
| 1 Pill | Bar › "Open Ricelin Pill settings" | Row order drag editor (`PillRowOrderEditor`, upstream BarModuleOrderEditor on `bar.pill.rowOrder`); clipboard history switch; Candy icons (enable + 2 opacities); Bar › Behavior: peek + duration; reset | `e07e86b` |
| 2 Sidebars | Sidebars | Size (width / full·fit·fixed / height per sidebar); Arrange: left Widgets-tab order row; Right: Layout default/compact, bar-only avatar Choose/Default, "Shown toggles" chips (`hiddenTypes`, both styles); YT Music + Screen Time switches hidden on KWin; reset | `9285655` |
| 4 Palettes | Themes › Colors | "My palettes" cards; Terminal Colors + Scheme Variant hidden on KWin; reset re-applies the palette file | `75f1c0c` |
| 5 Game mode | Quick › Game mode | chips for `gameMode.kwinEffects`; Niri switch hidden; auto-detect disabled on KWin (no window state) | `75f1c0c` |
| 6 Reset & shortcuts | Advanced › Reset & shortcuts | shortcut list + global reset (backs up config first); app-theming switches hidden with a note; **Meta+Comma** registered | `75f1c0c` |
| 7 Notifications | Panels › Notifications | low / critical / ignore-app / max popup time | `75f1c0c` |

Fixed on the way: `SidebarLayoutEditor` used `Array.isArray` on Config lists,
so Arrange showed and wrote back the *default* order. Remaining
`Array.isArray` uses on config values are in features the port doesn't use
(Orbit shelf, desktop widgets) or on JSON-parsed strings (settings nav/chrome).

Theming guards (`6c5ed14`): `Directories.wallpaperSwitchScriptPath` is a blocked path (all 15
switchwall.sh callers), Vesktop generation gated on `defaultApplyExternal`, auto-regen just
re-reads `colors.json`. Nothing outside the bar reads `~/.local/state/quickshell/user/generated`.

## Phase 4 verification (2026-09-23)

Driven through `config.json` (as the settings window writes it), with the config backed up
and restored afterwards (identical):

| Check | Result |
|---|---|
| `bar.pill.rowOrder` live | ✔ pill reordered (peek + capture) |
| `appearance.candy.enable=false` live | ✔ upstream glyphs back |
| `sidebar.shellLayout.system.width` live | ✔ left edge moved exactly 160 px for 620→460 |
| `hiddenTypes` += nightLight (classic grid) live | ✔ only the toggle row changed |
| game mode + `kwinEffects` | ✔ unloaded exactly the 2 chosen, recovery file written, restored, file removed |
| survives restart | ✔ values kept; restart changed **no** keys; log clean |
| broken JSON | ✔ bar kept running, `.broken-*` copy, file not overwritten, writes blocked; recovers reads + writes after fix |
| Meta+Comma | ✔ via kglobalaccel invoke: opens, second press closes |
| UserPalettes first call after start | ✘→✔ fixed (async folder scan) |
| real settings window (Themes) | ✔ renders My palettes |

Not driven: clicks/drags themselves (can't click from a session) — see CLAUDE.md
*Needs Camron*. YT Music is dropped.
