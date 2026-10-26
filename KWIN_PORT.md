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
- **niri's per-output sliding workspaces.** No KWin equivalent; dots are a fixed row matching
  the desktop count. (niri's *column* layout is what the scrolling tiler below brings back, with
  its own minimap beside the dots; upstream's pill never had one.)
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
  (autostart entry moved out of `~/.config/autostart/` — a `.desktop.disabled` rename
  is still launched by systemd's autostart generator; code kept as a style reference). Opens
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

- ~~Night light toggle does nothing~~ — **ported** (`services/Hyprsunset.qml` › *KWin*):
  the bar drives KWin's own Night Light through `kwinrc [NightColor]` (Mode=Constant,
  `--notify`) and follows `/org/kde/KWin/NightLight` over D-Bus. The bar's saved state wins:
  it is re-applied (and Mode forced to Constant) at every bar start.
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
  autostart entry, now moved out of `~/.config/autostart/` (a `.desktop.disabled` rename
  was still launched by systemd's autostart generator — a second bar ran on 2026-09-24).
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

## Left sidebar UI (2026-09-24)

All in `modules/sidebarLeft/`; the Widgets tab is `WidgetsView.qml` (header + scroll) →
`widgets/DraggableWidgetContainer.qml` (the item list: order, sizes, spacers, edit mode).

| Feature | Where | Config (`sidebar.widgets.*` unless noted) |
|---|---|---|
| Item order / visibility | `DraggableWidgetContainer` | `widgetOrder`, one bool per item (`media`, `week`, `context` = weather, `note`, `launch`, `controls`, `status`, `crypto`, `wallpaper`, `worldClock`) |
| Sizes Normal/Tall/Fill | same | `itemSizes: ["id=tall"…]` — tall 1.5×, fill shares leftover height; only Quick note (and spacers) stretch, others are centred in their slot |
| Blank spacers | same | `spacers: ["spacer-N=<px>"]`, placed via `widgetOrder` |
| **Edit mode** (Edit/Done under the items) | same, `arranging` | writes the keys above; ✕ hides, size chip cycles, drag anywhere, Add tray |
| Settings UI for the above | `modules/settings/InterfaceConfig.qml` › Widgets › *Sizes & spacing* | — |
| Controls card (toggles | actions) | `widgets/ControlsCard.qml` | `controlsCard.show*` (EasyEffects, Caffeine added; Network/Bluetooth hidden by him) |
| Quick note: 5 notes, pin, ‹ ›, fresh note on open, Ctrl+Enter | `widgets/QuickNote.qml` | own store `~/.local/state/quickshell/user/quicknotes.json` (not the Notepad service) |
| Fast wheel scrolling | `WidgetsView.qml` + iNiR `StyledFlickable`/`StyledListView` | `interactions.scrolling.fasterTouchpadScroll: true`, `mouseScrollFactor` 120 |
| Controls card: "on" plate for toggles; Night light right-click → Eye protection dialog | `ControlsCard.qml` (`Toggle` sets `toggled`); `GlobalStates.requestNightLightDialog`, taken by `SidebarRightContent`/`CompactSidebarRightContent` on the matching output | — |

Controls card icons are candy SVGs, which keep their own colours, so the glyph recolour
upstream uses for "on" never showed; a soft primary plate (RippleButton `toggled`) does.
The night-light right-click opens the right sidebar on the left sidebar's output; each
monitor has its own right sidebar, so only the one on `sidebarRightPresentationOutput` takes
the request (also checked on load, in case its content isn't resident yet).

Traps hit building these (all fixed):
- **z only orders siblings.** Controls inside a child container can't rise above a sibling
  overlay (the edit drag layer, z 15) — put clickable controls on the same level as the overlay.
  `childAt()` walks declaration order and ignores z, so it's only a valid probe when both agree.
- **A `Flow` sized by the layout only while visible** + a child with `width: parent.width`
  relaid out forever when hidden → the sidebar hung (100 % CPU, never presented, IPC dead).
  Give such children an explicit width.
- **Button base types have FINAL `icon` (and `highlighted`)** — custom props on RippleButton
  must use other names (`glyph`, `lit`), or the component fails to load.
- A Loader's `height: undefined` after an explicit height didn't reset → overlap. Bind always.
- Settings controls write on init (`onCheckedChanged`); Config skips equal plain values, and
  list writes must compare first (see `InterfaceConfig` *Sizes & spacing*).

## Pill status cluster: wifi + inbox hidden (2026-09-24)

He doesn't want the wifi signal icon or the notification bell taking up space in the top
pill (same preference already applied to the left sidebar's Controls card, above). Pure
config, no QML touched: `modules/pill/Pill.qml:1070` (`wifiIcon`) and `:1176` (`inboxIcon`,
the bell) are each gated on `pill.hoverModules?.wifi` / `?.inbox`, which read
`Config.options.bar.pill.modules`. Set `wifi: false` and `inbox: false` there
(`~/.config/pillbar/config.json`) and restarted the service. Undo: flip both back to `true`
and restart, or restore `backups/config-before-hide-wifi-inbox-1790280239.json` from the bar
repo. Other pill items (battery, weather, tray, mixer, power, sidebars, workspaces) untouched.

## Quick Note gets a real icon, Events & Reminders inherits its old one (2026-09-24)

Left sidebar Quick Note's header (`widgets/QuickNote.qml`) swapped the `edit_note` Material
glyph for candy-icons' `bijiben` (a notes-app icon, symlinked to `accessories-notes.svg`),
drawn via `IconImage { source: Quickshell.iconPath("bijiben", true) }` — same pattern as
`pill/CandyStatusIcon.qml`, so it follows the shell's active icon theme (`pragma IconTheme
candy-icons` in `shell.qml`) rather than a hardcoded path. `edit_note` then moved to the right
sidebar's Events & Reminders (`sidebarRight/events/EventsWidget.qml` and its five tab/label
sites in `BottomWidgetGroup.qml`, `SidebarRightContent.qml`, `CompactSidebarRightContent.qml`
×2, `settings/SidebarsConfig.qml`), which previously used `event_upcoming`.

**Not touched, on purpose:** Dashboard's separate "Agenda"/"Notes" cards (own labels, same
`event_upcoming`/`edit_note` glyphs reused independently) — different feature, wasn't asked
about. Also left as the plain `edit_note` glyph: the Quick Note entry in
`DraggableWidgetContainer.qml`'s `itemIcons` (only shown as a small chip when Quick Note is
hidden via Edit mode) and its `InterfaceConfig.qml` settings-switch icon — both render through
`MaterialSymbol`/`OptionalMaterialSymbol`, which are ligature-text only and have no image
support, unlike the header. Say the word if you want those made image-consistent too; it'd
mean adding a `candy:`-prefixed image path to those two components (the "To Do" tab icon
already uses a `candy:todo` prefix, so there's precedent).

Process note: these six files were edited directly in the live tree instead of staging first
(should have gone through `staging/pillbar/` + `test-staging.sh` per the normal workflow) —
low-risk, icon-only changes using an already-proven `IconImage`/`Quickshell.iconPath` pattern,
but staging has since been synced to match so the trees don't drift.

## Glance header volume control hidden (2026-09-24)

He doesn't want the volume button on the left sidebar's glance header at all — icon, percent
number, and scroll-to-adjust. Config-only: `sidebar.widgets.glance.showVolume` was already a
flag (`widgets/GlanceHeader.qml:149`, gates the whole `Item` at line 145 including its
`MouseArea onWheel` scroll handler), so no QML touched — set it `false` in
`~/.config/pillbar/config.json` and restarted. Backup:
`backups/config-before-hide-glance-volume-<ts>.json` in the bar repo. Undo: flip back to
`true` and restart. The GameMode and DND indicators next to it (`showGameMode`, `showDnd`)
are untouched. The "Scroll to adjust volume" tooltip fix from earlier today
(`visible: root.volumeMuted`) is now dead code while this is off, but harmless — it's correct
again if volume is ever turned back on.

## Screenshots: bar panels step beneath Spectacle (2026-09-24)

An open sidebar (or pill panel/toast) is a layer-shell **Overlay** surface, which KWin
stacks above everything — including Spectacle's region selector (KWin's fullscreen/active
layer), so the selection box was drawn *behind* an open sidebar. The KWin script
`helpers/kwinir-fullscreen.js` now also reports `capture` (a fullscreen `org.kde.spectacle`
window exists); `kwinir_bridge.py` whitelists it; `KWinBridge.capture` drives
`SidebarHost` (layer Overlay → Top, keyboard focus None) and `PillBar` (no Overlay
presentation, no keyboard focus). They return when the selector closes; the frozen snapshot
still contains the sidebar, so it can be snipped. Spectacle is excluded from `fullscreen`
(it isn't a game). Quickshell only re-layers the *open* sidebar; a closed one stays on
Overlay but is invisible with an empty input region.

**The bridge script had not been running.** `load_script` ran it via
`/Scripting/Script<id>.run`, but KWin numbers a new script by the current script count, so
after any unload the id can equal a still-loaded script's and the new script's D-Bus path is
never registered — `run()` reached the other script and ours never started (fullscreen
auto-detect for game mode was dead too). It now calls `Scripting.start()`, which runs every
loaded, stopped script.

## Scripts for existing buttons: clipboard, music recognition, voice (2026-09-25)

Four upstream scripts copied **verbatim** (no patches) because QML already in the bar calls them:

| Script | Called by | What was broken without it |
|---|---|---|
| `scripts/clipboard-store.py` | `Cliphist.decodeCommand()` pipes every copy/paste out of the history through `--filter` | **Copying from clipboard history gave an empty clipboard** (the pipe ended in a missing file). It also strips Firefox/Chromium `text/html` wrappers so pasted entries come out as clean text |
| `scripts/musicRecognition/recognize-music.sh` | `SongRec` ← Music recognition quick toggle (in `quickToggles` list) | toggle always reported "Make sure you have songrec installed" |
| `scripts/voiceSearch/record-voice.sh`, `transcribe-audio.py` | `VoiceSearch` ← AI chat mic (dictation), Voice search toggle | no recording, no transcription |

The bar's own `wl-paste --watch cliphist store` watcher (`clipboard.historyWatcher`) is
unchanged: upstream stores text through `clipboard-store.py` too, but the decode-time filter
already cleans old and new entries on the way out, so the watcher wasn't touched.

Music recognition: listens to the default sink's monitor (or the mic), every
`musicRecognition.interval` s up to `timeout` s; on a match it sends a notification and, as
upstream does without `dunstify`, opens the Shazam page in the browser.

Voice: provider `auto` → local whisper.cpp if installed, else the first stored key of Groq,
Gemini, OpenAI. Config `voiceSearch.geminiModel` was upstream's `gemini-2.5-flash`, which
Google now 404s for new users; set to `gemini-3.1-flash-lite` (verified: exact transcript of a
synthesized clip; `gemini-3.8-flash` was returning 503 overloaded at the time, text requests too).

Still not extracted, by decision: `colors/random/random_{konachan,osu}_wall.sh` (would replace the
Plasma wallpaper via niri/Hyprland paths), `hyprland/get_keybinds.py` (reads Hyprland config;
a KDE-shortcuts cheatsheet was offered and declined), `videos/record.sh` (wf-recorder doesn't
work on KWin; recorder is ported to Spectacle), `emoji/emoji-data.sh` and `setup/_scan.sh`
(launcher/overview only, not loaded).

## Scrolling tiling (KWin script) (2026-10-26)

niri-style columns on KWin, on by default (`tiling.enable`). Plan and decisions:
`~/.local/share/Fancy-Floating-Bar/docs/TILING_PLAN.md`; every measured KWin fact:
`docs/REFERENCE.md` › *KWin scripting facts for tiling*.

**What it does.** Windows on a tiling monitor live in a *strip* per (monitor, virtual desktop):
columns, each with one or more stacked windows. The focused column is always scrolled into view.
KWin will not park a window fully off the monitors (it clamps to keep a sliver visible), so a
column that is not **fully** inside the viewport is **minimized** and restored when scrolled back;
only windows the tiler minimized are ever restored by it. Keys are KWin global shortcuts the
script registers (Settings › Tiling › Keys lists them). Dialogs, transients,
fixed-size windows, all-desktop windows, layer-shell surfaces and the `tiling.floatClasses` list
never tile; KWin's own maximize means *maximize this column*, and a window that starts maximized
is un-maximized when taken over. **Portrait monitors run transposed** (`strip.vertical`): the strip
scrolls top to bottom and a column's windows sit side by side; the pure layout is written in main
axis / cross axis so one code path serves both, and the directional commands follow the screen.

**Mouse (2026-10-26, round 2).** *Resize:* the border shared with a fully visible neighbour
moves — the neighbour gives up exactly what the dragged window gains (live, through
`interactiveMoveResizeStepped`), so the pair keeps its span and nothing leaves the viewport
(before this, widening one column pushed its neighbour partly off-screen, where it was
minimized: "it grabs the edge and the one it expands over minimizes"). An outer edge resizes
just its column; borders between stacked windows trade height (`strip.weights`, reset whenever a
stack's members change); an outer edge of a stack snaps back. *Move:* a dragged window re-enters
the strip in the slot its centre falls in, on the monitor it ended up on (no longer floats; a
monitor that doesn't tile floats it there; < 6 px snaps back). *Reverts:* a client that resizes
or moves itself off its slot is put back after 250 ms, at most 3 times per 5 s.
*Fixed regions (2026-10-26, round 4):* a monitor can use `zone`s instead of strips. The slots are
the leaf tiles of KWin's own tile layout for (output, desktop), read through
`workspace.rootTile(output, desktop)` (`leafRects`: fractions of the root, nested layouts
supported) and re-read every 1.5 s, so Meta+T edits apply live; the tiler never writes
`window.tile` or `kwinrc`, it only positions windows itself. A slot holds a stack of windows, all
visible, split evenly; there is no scrolling and no minimizing. New windows: `zoneSlotFor`
(`smart`: slot holding the same app, else largest empty slot, else focused; or `focused`). Per
output mode = `tiling.regionOutputs` unless `toggle-mode` (Meta+Alt+G) flipped it at runtime
(`state.modeFlip`, not persisted); changing it migrates the windows between containers
(`migrateModes`). Drag-resize in a slot snaps back, drops pick the slot under the window, quick
tile: see above. Same-app *cycling* (several windows of one app sharing one slot,
one shown) was asked for and then dropped: same-app windows stack. Verified by the fake-KWin
tests; the live check is below.
*Meta+arrow keys (round 5):* intercepting KDE's quick tile (tile set, cleared, frame restored, then
our own write) bounced windows around and, on a full-width window, hopped it straight to the next
monitor. With `--quicktile` (`tiling.takeOverQuickTile`, default on) the bridge now **releases
KDE's four "Window Quick Tile Left/Right/Top/Bottom" bindings** through
`org.kde.KGlobalAccel.setShortcut(..., [], 4)` before it loads the script, saving the originals to
`~/.local/state/pillbar/released-quicktile.json` first, and the tiler registers its own
`Snap left/right/up/down` on Meta+arrows. They are given back on every exit path (and swept on the
next start if the bar died); `REVERT-tiling-quicktile.sh` (project dir) does it by hand and
`tiling-rescue.sh` calls it. `directionalMove`: a column that can move that way moves; at the end of
the strip a wide column is cut to the default width and the strip is packed flush with that edge
(`strip.align`, honoured by `layoutAll` while everything fits) — KDE's "tile to the right half"; snapped
already, it hops to the next monitor that way and arrives at the edge it came from. Up/Down on a
landscape strip with nothing to reorder maximize / restore the column. A window the tiler does not
manage gets KDE's own quick tile back through `Component.invokeShortcut` by name. The old interception
stays as the fallback when the keys are not taken over.
*Split tiles (round 6):* `split-region` (Ctrl+Meta+S) cuts the focused slot of a regions monitor into a
top and bottom half (`zoneDerive` adds a key per KWin tile, the halves carry `half: 0/1`); windows are
re-seated by overlap (`zoneReseat`: a cut slot spreads its stack over the halves in order, merged slots
stack in order, and a Meta+T edit that removes the keyed tile just drops its split). KWin's tile layout
itself is never written (the Tile scripting API has no split). The split list lives in the tiler
(`state.splits`), is reported to the bar and written to `tiling.regionSplits` by `KWinBridge._syncSplits`,
and comes back with the config, so it survives a restart. Meta+arrow on a regions monitor only
moves a window to the neighbouring slot (`zoneNeighbour`; no stack reorder, no monitor hop); on a
scrolling monitor it does nothing unless `tiling.arrowKeysScrollStrips`.
*Reserve and scroll (round 7, replaces the round-6 "overlay"):* `tiling.newWindowOverlay` (default on,
name kept): `openTarget` picks the tiled window a new window replaces (same app on screen, else the
focused one); the new window takes its cell (`replaceInContainer`) and the replaced window goes to
the **reserve** of that (monitor, desktop) container (`container.reserve`, hidden = minimized by us
through the normal `layoutAll` hide path). A reserve is per container, so it can never hold or pull a
window of another monitor; a window dragged elsewhere is untiled and re-tiled there. `scroll-next` /
`scroll-prev` (Meta+Shift+Down / Up, free keys; Meta+Shift+Left/Right stay KDE's move-to-screen)
rotate the focused cell through that reserve (`scrollReserve`). Closing a tiled window with a
non-empty reserve hands its cell to the most recently replaced one; a reserve window restored by
the user (taskbar, Latte, Alt+Tab) takes the focused cell (`bringFromReserve`). Mode flips and
output loss carry the reserve along (`windowsOf`). The first overlay design (covered, not minimized)
was dropped because z-order and "who is on top" could not be tracked reliably.
*Modifier drag floats:* a move that starts inside the window rather than on its title bar
(`workspace.cursorPos` vs `clientGeometry`; KWin exposes no keyboard-modifier API) floats the
window; resizes never float. *Quick tile:* KWin's Meta+arrow keys set `window.tile`; on a tiled
window the tiler clears it (`w.tile = null` restores the old frame) and moves the window in that
direction instead, hopping to the neighbouring tiling monitor past the end of the strip. Checked
live on KWin 6.8.1 with one throwaway window (`invokeShortcut "Window Quick Tile Left"` through
kglobalaccel): tile cleared, column moved, no errors. Meta+Shift+arrows (move to screen) are KWin's
own and land through the normal output-change path (covered by fake tests only). A window moved to another desktop or monitor re-tiles there (or floats if that
monitor doesn't tile). If a monitor goes away its windows join the first tiling monitor.

**Pieces and patches** (all marked `// KWin port:` or new files; nothing upstream was modified
beyond the lines below):

| File | Change |
|---|---|
| `helpers/kwinir-tiling.js` | **New.** The tiler: pure layout (unit-tested in node) + KWin glue. Idle until the bridge sends `config`; reports state (no window titles) |
| `helpers/kwinir_bridge.py` | `--tiling` loads/unloads the script; `NextCommand`/`Ack` long-poll (heartbeat every 12 s); stdin channel for config/commands with whitelists and range checks; validated reports; `release-all` + 1 s wait before unloading; unregisters the `KWiNiR Tiling: ` shortcuts; a replaced bridge no longer unloads the winner's scripts |
| `services/KWinBridge.qml` | `tiling` state, `sendTiling()`, config pushed to the helper (debounced), `--tiling` when `tiling.enable` |
| `services/KWinService.qml` | `liveWindows` = tiled windows in niri's shape while tiling is on (no consumers today) |
| `modules/common/Config.qml` | `tiling.*` options |
| `shell.qml` | IPC target `tiling` |
| `modules/pill/PillTiling.qml`, `Pill.qml` | **New** column minimap beside the workspace dots |
| `modules/settings/TilingConfig.qml`, `SettingsPageRegistry.qml` | **New** Settings › Tiling page (page 29; layout / apps / keys). Its Layout card borrows the shape of upstream `NiriConfig` › Layout (gaps, focus centring, single-column options, struts) but writes `tiling.*`, not niri's config |
| `modules/pill/PillSettings.qml`, `GlyphIcon.qml` | the settings menu's "Workspaces" entry (upstream's niri edge-strip page) now opens Tiling; new `columns` glyph |
| `TILING_CHEATSHEET.md` | **New** keys / mouse / settings reference |

**Keys** (checked against kglobalaccel; the three bindings that were in the way were released
with Camron's OK — `REVERT-tiling-keys.sh` in `~/.local/share/Fancy-Floating-Bar` gives them back):
`Meta+Alt+H/L` focus column, `Ctrl+Alt+←/→` the same, `Meta+Alt+J/K` and `Ctrl+Alt+↓/↑` focus
window in a column, `+Shift` moves the column / window, `Meta+Alt+[` `]` pull a window into the
left / right column or push it out, `R` cycle width, `F` maximize column, `C` center, `V` float.
Released: Meta+Alt+K and Meta+Alt+L (keyboard-layout switching), Meta+Alt+R (screen recording).

**Limitations.**
- Minimizing is the price of staying inside the monitor: the `magiclamp` effect (if loaded)
  animates every hide, hidden columns show as minimized in the task list, and minimizing the
  focused window moves KWin's focus, which the tiler corrects. A script cannot turn the effect
  off for itself.
- A new window only tiles if it opens on a tiling monitor.
- Real drags and key presses are not exercised by the automated tests (a session can't click or
  type): drag resize/move are covered by the fake-KWin tests, which emit KWin's
  `interactiveMoveResizeStarted/Stepped/Finished`; the signals and the `window.resize` flag were
  confirmed to exist on KWin 6.8.1.
- If the bar dies uncleanly while columns are minimized they stay minimized; the next start
  does not adopt minimized windows. Recovery: `sh tools/tiling-rescue.sh` (un-minimizes every
  window, pulls overhanging ones back on-screen, unregisters the tiler's shortcuts).
- The tiler does not touch `kwinrc`, KWin window rules or any Plasma setting. Its only
  persistent trace is the `KWiNiR Tiling: *` entries in `kglobalshortcutsrc`, which the bridge
  removes whenever tiling is off.

**Verification.** `tools/tiling-test.mjs` (layout and regions model, 39), `tiling-glue-test.mjs` (fake KWin: 79,
incl. hotplug, desktops, drag resize/move, portrait), `tiling-bridge-test.py` (validators, 17), `tiling-live-test.py` and
`tiling-live-multi.py` (real KWin, throwaway windows), `tiling-e2e-test.py` (the staged bar on a
temp config: IPC, bridge, shortcuts, release on exit). All in `~/.local/share/Fancy-Floating-Bar/tools/`.
