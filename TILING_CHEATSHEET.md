# Tiling cheat sheet

niri-style scrolling tiling on KWin. Every window is a **column** in a strip that scrolls
sideways; a column can hold several windows stacked top to bottom. Columns scrolled out of view
are minimized and come back when you scroll to them. Each monitor and each virtual desktop has
its own strip.

**Portrait monitors run the other way:** the strip scrolls top to bottom, so each window is a
full-width **row**, and windows that share a row sit side by side. Everything below says
"column"; read it as "row" on a portrait monitor.

## Keys

`Meta` = Super. All of these are KDE global shortcuts (System Settings › Shortcuts › KWin,
named *KWiNiR Tiling: …*), registered only while tiling is on.

### Move around

| Keys | Landscape monitor | Portrait monitor |
|---|---|---|
| `Meta+Alt+H` / `Ctrl+Alt+←` | focus the column to the left | focus the window to the left in this row |
| `Meta+Alt+L` / `Ctrl+Alt+→` | focus the column to the right | focus the window to the right in this row |
| `Meta+Alt+K` / `Ctrl+Alt+↑` | focus the window above in this column | focus the row above |
| `Meta+Alt+J` / `Ctrl+Alt+↓` | focus the window below in this column | focus the row below |

### Rearrange

| Keys | Does |
|---|---|
| `Meta+Alt+Shift+H / L` | move the window left / right (landscape: the whole column; portrait: within its row) |
| `Meta+Alt+Shift+K / J` | move the window up / down (landscape: within its column; portrait: the whole row) |
| `Meta+Alt+[` | previous column: pull this window into it, or (if the window is stacked) push it out into its own column on the left |
| `Meta+Alt+]` | the same toward the next column |
| `Meta+Alt+V` | float this window / put it back in the strip |

### Size and scroll

| Keys | Does |
|---|---|
| `Meta+Alt+R` | cycle the column width through 33 % → 50 % → 67 % (row height on a portrait monitor) |
| `Meta+Alt+F` | maximize the column, again to go back |
| `Meta+Alt+C` | center the column in the view |

## Mouse

- **Drag a border** between two windows: the neighbour gives way by exactly what you take, so
  both stay on screen. Works on column borders and on the border between stacked windows.
- **Drag an outer edge** of the first/last window: only that column changes size.
- **Drag a window by its title bar** and let go: it drops into the slot under it, on whatever
  monitor you dropped it. A nudge of a few pixels just snaps it back.
- Dropped on a monitor that doesn't tile → it floats there. `Meta+Alt+V` tiles it again.
- **Pill minimap** (beside the desktop dots): one segment per column, bright = on screen,
  accent = focused. Click one to focus that column.
- **Maximize button / double-click title bar** maximizes *that window's column*.
- **Minimizing** a window takes it out of the strip until you restore it.

## What floats on its own

Dialogs, pop-ups, fixed-size windows, windows on all desktops, Spectacle, KRunner, the
polkit/KWallet prompts, Klipper, Latte, Steam games (`steam_app_*`), pinentry and anything named
`kwinir-float*`. Add your own under Settings › Tiling › Apps › *Never tile these apps*.
To tile only some apps, list them under *Only tile these apps*.

## Settings (Meta+, › Tiling, or the pill's settings menu › Tiling)

| Option | Notes |
|---|---|
| Tile windows | the master switch; off gives every window back |
| Monitors | main only, or every monitor (`@primary` / `@all`: follow KDE's ranking, not cable names) |
| Gap size | `0` = edge to edge |
| New column width | the width a new window opens at |
| Focus behavior | when focusing scrolls the column to the middle: never / on overflow / always |
| Always center a single column · Auto-expand a single tiling window | lone-window behaviour |
| Stack windows vertically | portrait monitors scroll top to bottom |
| Dock strip at the bottom | px kept clear at the bottom of portrait monitors, for a dock's hover strip |
| Struts | px kept clear on each edge of every tiling monitor |

## From a terminal

```sh
qs -c pillbar ipc call tiling status            # one line per monitor
qs -c pillbar ipc call tiling toggle            # enable / disable (also: enable, disable)
qs -c pillbar ipc call tiling command focus-left
qs -c pillbar ipc call tiling commandArg focus-column 2
```

Commands: `focus-left/right/up/down`, `move-column-left/right`, `move-window-up/down`,
`consume-left/right`, `expel`, `consume-or-expel-left/right`, `cycle-width`, `maximize-column`,
`center-column`, `float-toggle`, `adopt [class]`, `focus-column N`, `relayout`.

## If something goes wrong

- A window is stuck minimized or off-screen: `sh ~/.local/share/Fancy-Floating-Bar/tools/tiling-rescue.sh`
- Windows look wrong after a monitor change: `qs -c pillbar ipc call tiling command relayout`
- Give everything back: turn tiling off (Settings › Tiling, or `ipc call tiling disable`).
- Game mode (fullscreen game) switches off the minimize animation along with the other effects.
- Meta+Alt+K / L / R used to switch keyboard layout / record the screen; they were released for
  tiling. `sh ~/.local/share/Fancy-Floating-Bar/REVERT-tiling-keys.sh` gives them back.
