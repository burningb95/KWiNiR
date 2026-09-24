# KWiNiR

[iNiR](https://github.com/snowarch/inir)'s Material ii **pill bar** and both **sidebars**,
running as a standalone [Quickshell](https://quickshell.outfoxxed.me) shell on
**KDE Plasma 6 / KWin Wayland** — no compositor switch, no system-wide theming.

The QML is iNiR's own (v2.31.0, `9574fa42`), copied verbatim; only the compositor-facing
pieces are rewired to KWin. The first commit in this repository is that unmodified
upstream subset, so `git diff <first-commit>` shows every change made for KWin.
[`KWIN_PORT.md`](KWIN_PORT.md) documents each patch and every known limitation.

Not affiliated with the iNiR project.

## What works on KWin

- Pill bar with workspace dots (KWin virtual desktops via D-Bus), media, tray, clock,
  notifications as pill toasts
- Left feature sidebar and right control center (quick toggles, sliders, notifications inbox)
- Notification server (replaces Plasma's popups; see *Notifications* below)
- Caffeine through the Wayland idle-inhibit protocol, respected by PowerDevil
- Pill power menu: lock, logout, reboot, shutdown through Plasma's session manager

Not available: anything needing a window list (KWin exposes no foreign-toplevel protocol
to Quickshell), per-output workspaces, and Plasma's file-transfer progress.

## Deliberately excluded

iNiR's `scripts/` directory is not included (only two read-only keyring lookups under
`scripts/keyring/`, for AI-provider keys). Its wallpaper/color generation and everything that
rewrites terminal, GTK/Qt, icon or other apps' themes is also **blocked in code**, not just
missing: `Directories.wallpaperSwitchScriptPath` points at a blocked path and
`MaterialThemeLoader.defaultApplyExternal` is hard-wired `false`. The matching settings
(Terminal Colors, Scheme Variant, app theming switches) are hidden on KWin. Colors come from
a static `colors.json` (see *Palettes*).

## Install

Requires Plasma 6 on Wayland, Quickshell ≥ 0.3.1, and the Material Symbols fonts.

```sh
git clone https://github.com/burningb95/KWiNiR.git ~/.config/quickshell/pillbar

# palette (any Material 3 colors.json works)
mkdir -p ~/.local/state/quickshell/user/generated
cp ~/.config/quickshell/pillbar/extras/theme/colors.plum.json \
   ~/.local/state/quickshell/user/generated/colors.json

# start before plasmashell so the bar owns notifications
cp ~/.config/quickshell/pillbar/extras/systemd/pillbar.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now pillbar
```

Configuration lives at `~/.config/pillbar/config.json` (iNiR's schema, created on first run).
For the sidebar avatar, put any image at `~/.config/pillbar/avatar.png` (or `.jpg`).

### Hotkeys

```sh
cp ~/.config/quickshell/pillbar/extras/applications/*.desktop ~/.local/share/applications/
```

then assign keys in *System Settings → Shortcuts* (or leave them unbound). Suggested:
Meta+Comma for settings, Meta+Shift+Space for the right sidebar, Ctrl+Shift+Space for the
left; "Pill bar: peek" is left unbound. Settings › Advanced › *Reset & shortcuts* lists them.
To remove one, delete its `.desktop` file and clear the key in System Settings (the
maintainer's own setup has `REVERT-*.sh` scripts for this). The IPC targets:

```sh
qs -c pillbar ipc call settings toggle        # settings window (openWindowAt <page>)
qs -c pillbar ipc call sidebarRight toggle
qs -c pillbar ipc call sidebarLeft toggle
qs -c pillbar ipc call pill peek               # reveal the pill briefly (stand-in for holding Super)
qs -c pillbar ipc call palette apply plum      # also: list / current
qs -c pillbar ipc call gamemode toggle         # also: activate / deactivate / status
qs -c pillbar ipc call idle toggle             # caffeine; also on / off / state
```

### Notifications

Only one process can own `org.freedesktop.Notifications`. The unit is ordered
`Before=plasma-plasmashell.service`, and Plasma yields when the name is taken. To give
notifications back to Plasma: `systemctl --user disable --now pillbar`, then restart
plasmashell.

## Customizing

Everything is in **one file, `~/.config/pillbar/config.json`**, using iNiR's schema.
It is watched: edits apply live, whether they come from the settings window, a text
editor or a script. Missing keys fall back to the defaults in
[`modules/common/Config.qml`](modules/common/Config.qml).

**Settings window** — Meta+Comma, the settings button in the pill or sidebar, or
`qs -c pillbar ipc call settings toggle`. What this port added:

| Page | What you can change |
|---|---|
| Bar › *Open Ricelin Pill settings* | hover-row **order** (drag between groups; eye = hide), surfaces, clipboard history, **candy icons**, size, clock, glyphs |
| Bar › Behavior & clock | auto-hide, **peek** duration |
| Sidebars | **size** of each sidebar, section / tab / **widget order** (tap to lift, tap to place), layout default/compact, avatar, **shown quick toggles** |
| Themes › Colors | **My palettes** (files in `extras/theme/`) above iNiR's presets |
| Quick › Game mode | which **KWin effects** game mode pauses (never written to kwinrc) |
| Panels › Notifications | popup timings per urgency, max popup time |
| Advanced › Reset & shortcuts | shortcut list, **reset everything** |

Every page has **Reset** at the bottom (click twice): *my setup* restores
`~/.config/pillbar/baseline.json`, *iNiR defaults* restores
[`defaults/inir-factory-config.json`](defaults/inir-factory-config.json).

### Options this port added

| Key | Default | Meaning |
|---|---|---|
| `bar.pill.rowOrder` | weather … power | hover-row item ids; `"|"` = divider (max 4) |
| `bar.autoHide.peek.{enable,durationMs}` | `true`, `2000` | `pill peek` reveal |
| `appearance.candy.{enable,idleOpacity,statusIdleOpacity}` | `true`, `0.8`, `0.82` | candy-icons layer |
| `appearance.userPalette` | `"plum"` | which `extras/theme/colors.<name>.json` is live |
| `clipboard.historyWatcher` | `true` | run `wl-paste --watch cliphist store` with the bar |
| `gameMode.kwinEffects` | 12 animation effects | unloaded while game mode is on (with `disableEffects`) |
| `sidebar.quickToggles.hiddenTypes` | `["cloudflareWarp"]` | toggles hidden in both styles |
| `sidebar.right.avatarPath` | `""` | bar-only avatar; `""` = `~/.config/pillbar/avatar.*` |

### Adding a configurable option

1. Declare it with its default in `modules/common/Config.qml`, next to its siblings
   (`property int myThing: 3`, with a `// KWin port:` comment). The default must equal the
   current hard-coded behavior.
2. Read it where the value was hard-coded:
   `Config.options?.section?.myThing ?? 3`. Config lists are QML `list<>`, **not** JS arrays:
   use `Array.from(...)`, never `Array.isArray(...)`.
3. Add a control on the relevant page in `modules/settings/` (`ConfigSpinBox`,
   `SettingsSwitch`, `ConfigSelectionArray`, `FilterChip`), writing with
   `Config.setNestedValue("section.myThing", value)`.
4. Regenerate the factory defaults: `tools/dump-factory-config.sh`.

### Backup and restore

- **Backup**: copy `~/.config/pillbar/config.json` (and `~/.config/pillbar/avatar.*`).
  *Reset everything* also leaves `config.json.bak-before-reset-<time>`.
- **Restore**: copy it back; the bar reloads it live.
- **Baseline**: `baseline.json` is what *Reset to my setup* uses; replace it with a copy of a
  config you like to move that target.
- **A broken file** (bad JSON) is never overwritten: the bar runs on defaults, keeps a
  `config.json.broken-<time>` copy, stops saving, and warns. Fix the JSON and it reloads.
- **Palettes**: applying one keeps the last 5 `colors.json.bak-*` beside the live
  `~/.local/state/quickshell/user/generated/colors.json`.

## License

GPL-3.0, as upstream iNiR — see [`LICENSE`](LICENSE).
