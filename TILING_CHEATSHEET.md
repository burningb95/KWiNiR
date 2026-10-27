# Tiling cheat sheet

niri-style scrolling tiling on KWin. Every window is a **column** in a strip that scrolls
sideways; a column can hold several windows stacked top to bottom. Columns scrolled out of view
are minimized and come back when you scroll to them. Each monitor and each virtual desktop has
its own strip.

**Portrait monitors run the other way:** the strip scrolls top to bottom, so each window is a
full-width **row**, and windows that share a row sit side by side. Everything below says
"column"; read it as "row" on a portrait monitor.

## New windows take a place; the replaced window waits (scroll with Meta+Shift+↑/↓)

With "New windows take the focused window's place" on (Settings › Tiling › Layout, default on), a
window you open (from Latte, a launcher, a terminal) does **not** get a column or region of its own:
it takes the place of a tiled window of the **same app** if one is on screen, otherwise of the
focused window on that monitor. Nothing scrolls and no other visible window moves. **On a regions
monitor this only happens once every region is occupied**: while a region is empty, a new window
fills it (same-app windows still stack in their app's region) and replaces nothing.
- The window it replaced goes to that monitor's **reserve**: hidden (minimized) and waiting.
- **`Meta+Shift+↓` / `Meta+Shift+↑`** replace the *focused* window with the next / previous window
  waiting in the reserve (a rotation: the one you replace joins the other end of the queue). Only the
  focused cell changes; the rest of the layout stays put.
- **Per monitor, always.** Each monitor (and virtual desktop) has its own reserve. Scrolling on one
  monitor never pulls a window from another. A window you drag to another monitor stays there and
  belongs to that monitor's layout from then on.
- Closing the new window brings back the one it replaced. Restoring a waiting window (taskbar, Latte,
  Alt+Tab) puts it in the focused cell and the one that was there waits instead.
- To keep a window visible for good, put it in its own cell: `Meta+arrow` / `Meta+Alt+1…6` move the
  focused window; drag a window by its title bar into another region; `Meta+Alt+V` floats it.
- The first window on a monitor (nothing to replace), dialogs and floating windows tile/float as usual.

## Two modes per monitor

- **Scrolling columns** (default): everything above. A new window opens as a new column, the
  view scrolls to it and columns that no longer fit are minimized.
- **Fixed regions**: nothing scrolls and nothing is minimized. The monitor is divided into the
  slots of **KDE's own tile layout for it** (the 25 % | 50 % | 25 % you set up with `Meta+T`);
  every window sits in a slot, and a slot holds a stack of windows split evenly top to bottom.
  - A new window goes to the slot already holding a window of the same app, otherwise to the
    largest empty slot, otherwise to the focused slot (Settings › Tiling › Regions can switch
    that to "always the focused slot").
  - Edit the slots with `Meta+T` (or Settings › Tiling › Regions › *Open KDE's tile editor*);
    the windows follow within a couple of seconds. Slots are numbered left to right (top to
    bottom when the layout is stacked).
  - Dragging a window drops it into the slot under it; dragging a border snaps back (the
    borders belong to the tile editor); `Meta`-drag still floats.
  - Choose which monitors start in regions mode under Settings › Tiling › Regions, or flip the
    focused monitor on the spot with `Meta+Alt+G` (windows keep their order).

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

### KDE's own window keys (still work, now tiling-aware)

| Keys | Does on a tiled window |
|---|---|
| `Meta+←/→/↑/↓` on a **regions** monitor | moves the window to the **neighbouring region** that way (within the monitor, never across monitors: `Meta+Shift+←/→` is KDE's move-to-screen). A region holding **one** window **swaps places** with it; an empty region just receives the window; a region that already holds a **stack** gets the window added to the stack. Nothing that way: it stays. No stack reordering, no scrolling |
| `Meta+←/→` on a scrolling monitor | **nothing**, unless Settings › Tiling › Keys › "Meta + arrows also move columns" is on. Then: moves the window that way (like `Meta+Alt+Shift+H/L`). At the end of the strip the window first **snaps to that edge of the monitor** (a full-width window becomes half width, flush against the edge, like KDE's "tile to the right half"); pressed again it **hops to the next monitor** that way and arrives at the edge it came in from. Nothing that way: stays put |
| `Meta+↑/↓` | moves the window up / down inside its stack; with nothing to reorder, `↑` maximizes the column and `↓` restores it (on a portrait monitor they work like `←/→` do on a landscape one) |
| `Meta+Shift+←/→` (move to previous / next screen) | KWin sends the window to that monitor and the tiler slots it in next to that monitor's focused column |

While tiling runs the tiler **owns the four Meta+arrow keys**: it releases KDE's quick-tile bindings at start and gives them back when tiling stops (Settings › Tiling › Keys has a switch). On a floating window, or one on a monitor that doesn't tile, Meta+arrows still do KDE's quick tile. If the bar ever dies mid-run and the keys stay released: `sh ~/.local/share/Fancy-Floating-Bar/REVERT-tiling-quicktile.sh`.

### Regions mode only

| Keys | Does |
|---|---|
| `Ctrl+Meta+S` | **split** the focused region into a top and a bottom half; press it again in either half to merge them back. Windows in the region spread over the halves in order. Persisted across restarts; keyed to the tile's rectangle, so editing that tile in Meta+T drops its split |


| Keys | Does |
|---|---|
| `Meta+Alt+1` … `6` | send the focused window to region 1 … 6 (bottom of that slot's stack) |
| `Meta+Alt+G` | flip the focused monitor between scrolling columns and fixed regions |
| the move / focus keys above | `H`/`L`: next slot left / right; `J`/`K`: down / up the stack, then the slot above / below. `Shift` moves the window the same way |
| `Meta+←/→/↑/↓` | same as the `Shift` moves; past the last slot it hops to the next monitor and lands in the slot nearest the edge it came in from |

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
- **`Meta` + left-drag floats the window** where you drop it (any drag that starts inside the
  window instead of on its title bar does: that is whatever KWin's *Window Actions* modifier is
  set to). `Meta` + right-drag resizes and never floats. Windows that draw their own title bar
  (Firefox-style) count their top 48 px as the title bar, so a `Meta`-drag that starts up there
  re-tiles instead of floating.
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
| Regions | which monitors use fixed regions, where new windows go, a button for KDE's tile editor |
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
`center-column`, `float-toggle`, `adopt [class]`, `focus-column N`, `relayout`, `send-to-slot N`,
`toggle-mode [monitor]`.

## If something goes wrong

- A window is stuck minimized or off-screen: `sh ~/.local/share/Fancy-Floating-Bar/tools/tiling-rescue.sh`
- Windows look wrong after a monitor change: `qs -c pillbar ipc call tiling command relayout`
- Give everything back: turn tiling off (Settings › Tiling, or `ipc call tiling disable`).
- Game mode (fullscreen game) switches off the minimize animation along with the other effects.
- Meta+Alt+K / L / R used to switch keyboard layout / record the screen; they were released for
  tiling. `sh ~/.local/share/Fancy-Floating-Bar/REVERT-tiling-keys.sh` gives them back.
