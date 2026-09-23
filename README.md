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

iNiR's `scripts/` directory is not included, so its wallpaper/color generation and the
parts that rewrite terminal, GTK/Qt and icon themes are unreachable. Colors come from a
static `colors.json` instead.

## Install

Requires Plasma 6 on Wayland, Quickshell ≥ 0.3.1, and the Material Symbols fonts.

```sh
git clone https://github.com/burningb95/KWiNiR.git ~/.config/quickshell/pillbar

# palette (any Material 3 colors.json works)
mkdir -p ~/.local/state/quickshell/user/generated
cp ~/.config/quickshell/pillbar/extras/theme/colors.candy.json \
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
Meta+Shift+Space for the right sidebar, Ctrl+Shift+Space for the left. The IPC targets:

```sh
qs -c pillbar ipc call sidebarRight toggle
qs -c pillbar ipc call sidebarLeft toggle
qs -c pillbar ipc call idle toggle   # caffeine; also on / off / state
```

### Notifications

Only one process can own `org.freedesktop.Notifications`. The unit is ordered
`Before=plasma-plasmashell.service`, and Plasma yields when the name is taken. To give
notifications back to Plasma: `systemctl --user disable --now pillbar`, then restart
plasmashell.

## License

GPL-3.0, as upstream iNiR — see [`LICENSE`](LICENSE).
