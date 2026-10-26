#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""kwinir-bridge: KDE/KWin glue for the KWiNiR bar.

Quickshell 0.3 has no generic D-Bus server, so this small helper owns the D-Bus
names the bar needs and reports to it as one JSON object per line on stdout.
It is started by services/KWinBridge.qml as a child of the bar and exits with it.

  org.kwinir.Bridge      /Bridge         Event(s)    <- helpers/kwinir-fullscreen.js
                                                        (KWin script, loaded at runtime,
                                                        never written to KWin's config)
  org.kde.JobViewServer  /JobViewServer  V2 + V1     <- KIO file transfers (Dolphin...)
  (with --jobs)          + org.kde.kuiserver

File-transfer jobs are shown the community-standard way: an ordinary
freedesktop notification, updated in place (replaces_id), carrying the integer
"value" hint (progress bar in dunst / mako / swaync / this bar) and the
"transfer" category, with Cancel / Pause actions wired back to the job.

  KWin state polled in-process every 5 s (activeOutputName, activeEffects — KWin
  sends no change signal for either), so the bar doesn't spawn two gdbus calls a
  poll. Every poll is reported (the bar may have refreshed the output itself in between,
  so "unchanged since the last report" doesn't mean the bar has it).

stdout events: {"type":"ready"}  {"type":"fullscreen","value":bool}
               {"type":"capture","value":bool}  (Spectacle region selector up)
               {"type":"jobs","count":int}
               {"type":"output","value":str}  {"type":"overview","value":bool}
               {"type":"tiling","v":1,"enabled":bool,"outputs":{...}}  (with --tiling)

# KWin port: with --tiling the helper also loads helpers/kwinir-tiling.js (scrolling tiling,
  docs/TILING_PLAN.md). KWin scripts can't export D-Bus methods, so the script long-polls
  org.kwinir.Bridge.NextCommand; the helper answers with a "noop" heartbeat every 12 s (a held
  call dies silently at ~25 s). Commands and config come from the bar on stdin, one JSON
  object per line, and are validated here against a whitelist before they reach KWin:
    {"type":"tiling-config","config":{...}}   {"type":"tiling-command","name":str,"arg":..}
  On exit the helper asks the script to release every window it minimized and waits up to 1 s
  before unloading it, then unregisters the script's "KWiNiR Tiling: " global shortcuts.
"""

import ctypes
import json
import os
import re  # KWin port: tiling input validation
import signal
import sys
import time
import urllib.parse

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

try:  # PyGObject >= 3.52 moved these; fall back for older systems
    gi.require_version("GioUnix", "2.0")
    from gi.repository import GioUnix  # noqa: E402
    DesktopAppInfo = GioUnix.DesktopAppInfo
except (ValueError, ImportError):
    DesktopAppInfo = Gio.DesktopAppInfo
try:
    gi.require_version("GLibUnix", "2.0")
    from gi.repository import GLibUnix  # noqa: E402
    unix_signal_add = GLibUnix.signal_add
except (ValueError, ImportError):
    unix_signal_add = GLib.unix_signal_add


def register_object(bus, path, iface, method_cb):
    register = getattr(bus, "register_object_with_closures2", None) or bus.register_object
    return register(path, iface, method_cb, None, None)

HERE = os.path.dirname(os.path.abspath(__file__))
FULLSCREEN_SCRIPT = os.path.join(HERE, "kwinir-fullscreen.js")
SCRIPT_NAME = "kwinir-fullscreen"
# KWin port: scrolling tiling script (loaded only with --tiling)
TILING_SCRIPT = os.path.join(HERE, "kwinir-tiling.js")
TILING_NAME = "kwinir-tiling"
TILING_PREFIX = "KWiNiR Tiling: "
POLL_HEARTBEAT_MS = 12000   # a held NextCommand call dies silently at ~25 s
RELEASE_WAIT_MS = 1000      # how long quit() waits for the script to un-minimize everything
# Commands the bar may send. dump/windows/config/release-all are internal or debug only.
TILING_COMMANDS = {
    "focus-left", "focus-right", "focus-up", "focus-down", "move-column-left", "move-column-right",
    "move-window-up", "move-window-down", "consume-left", "consume-right", "expel",
    "consume-or-expel-left", "consume-or-expel-right", "cycle-width", "maximize-column",
    "center-column", "float-toggle", "relayout", "adopt", "focus-column",
    "send-to-slot", "toggle-mode", "snap-left", "snap-right", "snap-up", "snap-down",
}
CLASS_RE = re.compile(r"^[A-Za-z0-9._@+*-]{1,100}$")
# KWin port: with --quicktile (and --tiling) the stock Meta+arrow quick-tile bindings are released
# while tiling runs, so the tiler's own Meta+arrow shortcuts get the keys without a fight. The
# originals are written to STATE_FILE first and given back on exit (or on the next start).
QUICKTILE = (("Window Quick Tile Left", "Quick Tile Window to the Left", 0x11000012),
             ("Window Quick Tile Right", "Quick Tile Window to the Right", 0x11000014),
             ("Window Quick Tile Top", "Quick Tile Window to the Top", 0x11000013),
             ("Window Quick Tile Bottom", "Quick Tile Window to the Bottom", 0x11000015))
STATE_FILE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"),
                          "pillbar", "released-quicktile.json")
OUTPUT_RE = re.compile(r"^[A-Za-z0-9@._:-]{1,64}$")

SHOW_DELAY_MS = 1000       # quick jobs never flash a notification (KIO itself waits 500 ms)
UPDATE_INTERVAL_MS = 500   # at most two notification updates per second per job
NOTIFY_TIMEOUT_MS = 3000
KWIN_STATE_INTERVAL_MS = 5000  # same cadence as KWinService's own fallback poll

BRIDGE_XML = """
<node>
  <interface name="org.kwinir.Bridge">
    <method name="Event"><arg name="json" type="s" direction="in"/></method>
    <method name="NextCommand"><arg name="json" type="s" direction="out"/></method>
    <method name="Ack"><arg name="json" type="s" direction="in"/></method>
  </interface>
</node>"""

SERVER_XML = """
<node>
  <interface name="org.kde.JobViewServerV2">
    <method name="requestView">
      <arg name="desktopEntry" type="s" direction="in"/>
      <arg name="capabilities" type="i" direction="in"/>
      <arg name="hints" type="a{sv}" direction="in"/>
      <arg name="viewPath" type="o" direction="out"/>
    </method>
  </interface>
  <interface name="org.kde.JobViewServer">
    <method name="requestView">
      <arg name="appName" type="s" direction="in"/>
      <arg name="appIconName" type="s" direction="in"/>
      <arg name="capabilities" type="i" direction="in"/>
      <arg name="trackerPath" type="o" direction="out"/>
    </method>
  </interface>
</node>"""

VIEW_V3_XML = """
<node>
  <interface name="org.kde.JobViewV3">
    <method name="terminate">
      <arg name="errorCode" type="u" direction="in"/>
      <arg name="errorMessage" type="s" direction="in"/>
      <arg name="hints" type="a{sv}" direction="in"/>
    </method>
    <method name="update"><arg name="properties" type="a{sv}" direction="in"/></method>
    <signal name="suspendRequested"/>
    <signal name="resumeRequested"/>
    <signal name="cancelRequested"/>
  </interface>
</node>"""

VIEW_V2_XML = """
<node>
  <interface name="org.kde.JobViewV2">
    <method name="terminate"><arg name="errorMessage" type="s" direction="in"/></method>
    <method name="setSuspended"><arg name="suspended" type="b" direction="in"/></method>
    <method name="setTotalAmount"><arg name="amount" type="t" direction="in"/><arg name="unit" type="s" direction="in"/></method>
    <method name="setProcessedAmount"><arg name="amount" type="t" direction="in"/><arg name="unit" type="s" direction="in"/></method>
    <method name="setPercent"><arg name="percent" type="u" direction="in"/></method>
    <method name="setSpeed"><arg name="bytesPerSecond" type="t" direction="in"/></method>
    <method name="setElapsedTime"><arg name="elapsedTime" type="t" direction="in"/></method>
    <method name="setInfoMessage"><arg name="message" type="s" direction="in"/></method>
    <method name="setDescriptionField">
      <arg name="number" type="u" direction="in"/><arg name="name" type="s" direction="in"/>
      <arg name="value" type="s" direction="in"/><arg name="res" type="b" direction="out"/>
    </method>
    <method name="clearDescriptionField"><arg name="number" type="u" direction="in"/></method>
    <method name="setDestUrl"><arg name="destUrl" type="v" direction="in"/></method>
    <signal name="suspendRequested"/>
    <signal name="resumeRequested"/>
    <signal name="cancelRequested"/>
  </interface>
</node>"""

KJOB_KILLED = 1  # KJob::KilledJobError == KIO::ERR_USER_CANCELED: the user cancelled


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(f"[kwinir-bridge] {msg}\n")
    sys.stderr.flush()


def esc(text):
    """The bar renders notification bodies as markup; file names are untrusted."""
    return GLib.markup_escape_text(str(text or ""))


def human_size(n):
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def human_duration(seconds):
    seconds = int(max(0, seconds))
    if seconds < 60:
        return f"{seconds} s"
    if seconds < 3600:
        return f"{seconds // 60} min"
    return f"{seconds // 3600} h {seconds % 3600 // 60} min"


def location_path(value):
    value = str(value or "")
    parsed = urllib.parse.urlparse(value)
    return (urllib.parse.unquote(parsed.path) if parsed.scheme else value).rstrip("/")


def short_location(value):
    """'file:///home/me/a%20b.iso' -> 'a b.iso'."""
    path = location_path(value)
    return os.path.basename(path) or path


def file_dir_uri(value):
    """Directory URI for 'Open folder' — local file: URLs only (the job supplies this)."""
    value = str(value or "")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "file":
        return ""
    path = urllib.parse.unquote(parsed.path)
    if not os.path.isdir(path):
        path = os.path.dirname(path)
    if not os.path.isdir(path):
        return ""
    return GLib.filename_to_uri(path, None)


def app_info_for(desktop_entry):
    entry = (desktop_entry or "").removesuffix(".desktop")
    name, icon = entry, ""
    if entry:
        info = DesktopAppInfo.new(entry + ".desktop")
        if info:
            name = info.get_display_name() or name
            gicon = info.get_icon()
            icon = gicon.to_string() if gicon else ""
    return name, icon


class Job:
    def __init__(self, bridge, path, sender, desktop_entry, app_name, app_icon, capabilities, v3, immediate):
        self.bridge = bridge
        self.path = path
        self.sender = sender
        self.desktop_entry = desktop_entry
        self.app_name = app_name
        self.app_icon = app_icon
        self.capabilities = int(capabilities)
        self.v3 = v3
        self.state = {}
        self.notif_id = 0
        self.dismissed = False
        self.shown = False
        self.done = False
        self.reg_id = 0
        self.watch_id = 0
        self.started = time.monotonic()
        self._flush_source = 0
        self._last_flush = 0.0
        # Even "immediate" jobs wait a moment so their first update (title...) lands first.
        self._show_source = GLib.timeout_add(150 if immediate else SHOW_DELAY_MS, self._show_timeout)

    # -- state from the client -------------------------------------------------
    def update(self, props):
        if self.done:
            return
        self.state.update(props)
        self._schedule_flush()

    def terminate(self, error_code, error_message):
        if self.done:
            return
        self.done = True
        for attr in ("_show_source", "_flush_source"):
            source = getattr(self, attr)
            if source:
                GLib.source_remove(source)
                setattr(self, attr, 0)
        if self.notif_id:
            self.bridge.close_notification(self.notif_id)
        was_visible = self.shown and not self.dismissed
        self.notif_id = 0
        if error_code == 0:
            if was_visible:
                self._notify_finished()
        elif error_code != KJOB_KILLED:
            self._notify_failed(error_message)
        self.bridge.forget_job(self)

    # -- presentation --------------------------------------------------------
    def _show_timeout(self):
        self._show_source = 0
        if not self.done:
            self.shown = True
            self._flush()
        return False

    def _schedule_flush(self):
        if not self.shown or self.dismissed or self._flush_source:
            return
        wait = max(0, UPDATE_INTERVAL_MS - int((time.monotonic() - self._last_flush) * 1000))
        self._flush_source = GLib.timeout_add(wait, self._flush_timeout)

    def _flush_timeout(self):
        self._flush_source = 0
        self._flush()
        return False

    def title(self):
        return self.state.get("title") or self.app_name or "Transfer"

    def percent(self):
        if "percent" in self.state:
            return max(0, min(100, int(self.state["percent"])))
        total, done = self.state.get("totalBytes", 0), self.state.get("processedBytes", 0)
        return int(done * 100 / total) if total else -1

    def _route_line(self):
        src = self.state.get("descriptionValue1", "")
        dst = self.state.get("descriptionValue2", "") or self.state.get("destUrl", "")
        if src and dst:
            # "a.iso -> Downloads": when the destination is the copied file, name its folder.
            dst_name = short_location(dst)
            if dst_name == short_location(src):
                dst_name = os.path.basename(os.path.dirname(location_path(dst))) or dst_name
            return f"{esc(short_location(src))} → {esc(dst_name)}"
        if src:
            return esc(short_location(src))
        return esc(self.state.get("infoMessage", ""))

    def _detail_line(self):
        parts = []
        files_total, files_done = self.state.get("totalFiles", 0), self.state.get("processedFiles", 0)
        if files_total > 1:
            parts.append(f"{files_done} of {files_total} files")
        bytes_total, bytes_done = self.state.get("totalBytes", 0), self.state.get("processedBytes", 0)
        if bytes_total:
            parts.append(f"{human_size(bytes_done)} of {human_size(bytes_total)}")
        speed = self.state.get("speed", 0)
        if speed and not self.state.get("suspended"):
            parts.append(f"{human_size(speed)}/s")
            if bytes_total > bytes_done:
                parts.append(f"{human_duration((bytes_total - bytes_done) / speed)} left")
        return " · ".join(parts)

    def _flush(self):
        if self.done or self.dismissed or not self.shown:
            return
        self._last_flush = time.monotonic()
        suspended = bool(self.state.get("suspended"))
        summary = self.title() + (" (paused)" if suspended else "")  # summary is plain text
        body = "\n".join(line for line in (self._route_line(), self._detail_line()) if line)
        actions = []
        if self.capabilities & 0x2:
            actions += (["resume", "Resume"] if suspended else ["suspend", "Pause"])
        if self.capabilities & 0x1:
            actions += ["cancel", "Cancel"]
        hints = {
            "category": GLib.Variant("s", "transfer"),
            "desktop-entry": GLib.Variant("s", self.desktop_entry or ""),
        }
        pct = self.percent()
        if pct >= 0:
            hints["value"] = GLib.Variant("i", pct)
        self.notif_id = self.bridge.notify(self.notif_id, self.app_name, self.app_icon, summary, body,
                                           actions, hints, urgency=0, timeout=0)

    def _notify_finished(self):
        dest = self.state.get("destUrl", "") or self.state.get("descriptionValue2", "")
        folder = file_dir_uri(dest)
        body = "\n".join(line for line in (self._route_line(),
                                           human_size(self.state.get("totalBytes", 0))
                                           if self.state.get("totalBytes") else "") if line)
        nid = self.bridge.notify(0, self.app_name, self.app_icon, self.title() + " finished", body,
                                 ["open", "Open folder"] if folder else [],
                                 {"category": GLib.Variant("s", "transfer.complete")}, urgency=0, timeout=-1)
        if folder and nid:
            self.bridge.finished_folders[nid] = folder

    def _notify_failed(self, message):
        self.bridge.notify(0, self.app_name, self.app_icon, self.title() + " failed",
                           esc(message or "The transfer stopped with an error."), [],
                           {"category": GLib.Variant("s", "transfer.error")}, urgency=1, timeout=-1)

    # -- actions from the notification ---------------------------------------
    def action(self, key):
        iface = "org.kde.JobViewV3" if self.v3 else "org.kde.JobViewV2"
        signal_name = {"cancel": "cancelRequested", "suspend": "suspendRequested",
                       "resume": "resumeRequested"}.get(key)
        if signal_name and not self.done:
            self.bridge.bus.emit_signal(None, self.path, iface, signal_name, None)


# -- KWin port: tiling input validation ----------------------------------------------
# Everything that crosses from the KWin script to the bar, or from the bar to the script, is
# rebuilt from checked fields; nothing is passed through as received.
def _is_num(v, lo, hi):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi


def _str_list(v, max_items, max_len, pattern=None):
    if not isinstance(v, list) or len(v) > max_items:
        return None
    out = []
    for item in v:
        if not isinstance(item, str) or not (1 <= len(item) <= max_len):
            return None
        if pattern is not None and not pattern.match(item):
            return None
        out.append(item)
    return out


def clean_tiling_config(c):
    """Config from the bar -> the fields the script accepts (bad fields are dropped)."""
    if not isinstance(c, dict):
        return None
    out = {}
    if _is_num(c.get("gap"), 0, 100):
        out["gap"] = int(c["gap"])
    if _is_num(c.get("defaultWidth"), 0.1, 1):
        out["defaultWidth"] = float(c["defaultWidth"])
    presets = c.get("presetWidths")
    if isinstance(presets, list) and 1 <= len(presets) <= 8 and all(_is_num(x, 0.1, 1) for x in presets):
        out["presetWidths"] = [float(x) for x in presets]
    if c.get("center") in ("never", "on-overflow", "always"):
        out["center"] = c["center"]
    struts = c.get("struts")
    if isinstance(struts, dict):
        clean = {k: int(struts[k]) for k in ("left", "right", "top", "bottom") if _is_num(struts.get(k), 0, 512)}
        if clean:
            out["struts"] = clean
    if _is_num(c.get("portraitDockStrip"), 0, 200):
        out["portraitDockStrip"] = int(c["portraitDockStrip"])
    for key in ("portraitVertical", "centerSingle", "expandSingle"):
        if isinstance(c.get(key), bool):
            out[key] = c[key]
    outputs = _str_list(c.get("outputs"), 8, 64, OUTPUT_RE)
    if outputs:
        out["outputs"] = outputs
    region_outputs = _str_list(c.get("regionOutputs"), 8, 64, OUTPUT_RE)
    if region_outputs is not None:          # an empty list is valid: no output uses regions
        out["regionOutputs"] = region_outputs
    if c.get("regionsNewWindow") in ("smart", "focused"):
        out["regionsNewWindow"] = c["regionsNewWindow"]
    for key in ("onlyClasses", "floatClasses"):
        lst = _str_list(c.get(key), 200, 100, CLASS_RE)
        if lst is not None:
            out[key] = lst
    if isinstance(c.get("shortcuts"), bool):
        out["shortcuts"] = c["shortcuts"]
    return out


def clean_tiling_command(msg):
    """{name, arg} from the bar -> (name, arg) or None when it is not allowed."""
    name = msg.get("name")
    if name not in TILING_COMMANDS:
        return None
    arg = msg.get("arg")
    if name == "focus-column":
        if isinstance(arg, str) and arg.isdigit():
            arg = int(arg)
        return (name, arg) if isinstance(arg, int) and not isinstance(arg, bool) and 0 <= arg < 64 else None
    if name == "send-to-slot":
        if isinstance(arg, str) and arg.isdigit():
            arg = int(arg)
        return (name, arg) if isinstance(arg, int) and not isinstance(arg, bool) and 1 <= arg <= 9 else None
    if name == "toggle-mode":
        if arg in (None, ""):
            return (name, None)
        return (name, arg) if isinstance(arg, str) and OUTPUT_RE.match(arg) else None
    if name == "adopt":
        if arg in (None, ""):
            return (name, None)
        return (name, arg) if isinstance(arg, str) and CLASS_RE.match(arg) else None
    return (name, None)


def clean_tiling_report(e):
    """Report from the KWin script -> the object the bar sees (schema v1, no titles)."""
    if not isinstance(e, dict) or e.get("v") != 1 or not isinstance(e.get("enabled"), bool):
        return None
    outputs = {}
    raw = e.get("outputs")
    if not isinstance(raw, dict) or len(raw) > 8:
        return None
    for name, o in raw.items():
        if not isinstance(name, str) or not (1 <= len(name) <= 64) or not isinstance(o, dict):
            return None
        cols = o.get("columns")
        if not isinstance(cols, list) or len(cols) > 128 or not isinstance(o.get("desktop"), str) \
                or len(o["desktop"]) > 64 or not _is_num(o.get("scroll"), 0, 1) \
                or not _is_num(o.get("focusedColumn"), 0, 255):
            return None
        out_cols = []
        for col in cols:
            wins = col.get("windows") if isinstance(col, dict) else None
            if not isinstance(wins, list) or len(wins) > 32 or not _is_num(col.get("width"), 0, 1) \
                    or not isinstance(col.get("visible"), bool):
                return None
            out_wins = []
            for w in wins:
                if not isinstance(w, dict) or not isinstance(w.get("id"), str) or len(w["id"]) > 64 \
                        or not isinstance(w.get("app"), str) or len(w["app"]) > 64 \
                        or not isinstance(w.get("focused"), bool):
                    return None
                out_wins.append({"id": w["id"], "app": w["app"], "focused": w["focused"]})
            out_cols.append({"width": float(col["width"]), "visible": col["visible"], "windows": out_wins})
        outputs[name] = {"desktop": o["desktop"], "focusedColumn": int(o["focusedColumn"]),
                         "scroll": float(o["scroll"]), "vertical": o.get("vertical") is True,
                         "mode": "regions" if o.get("mode") == "regions" else "strip", "columns": out_cols}
    return {"type": "tiling", "v": 1, "enabled": e["enabled"], "outputs": outputs}


class Bridge:
    def __init__(self, jobs_enabled, tiling_enabled=False, quicktile=False):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.loop = GLib.MainLoop()
        self.jobs_enabled = jobs_enabled
        self.jobs = {}              # path -> Job
        self.by_notif = {}          # notification id -> Job
        self.finished_folders = {}  # notification id -> folder uri
        self.next_job = 1
        self.bridge_name_owned = False
        self.kwin_present = False
        self.script_loaded = False
        # KWin port: tiling
        self.tiling = tiling_enabled
        self.quicktile = quicktile and tiling_enabled
        self.tiling_loaded = False
        self.tiling_config = None   # last validated config from the bar
        self.config_sent = False    # per script load: the first reply to NextCommand is `config`
        self.cmd_queue = []
        self.held_poll = None
        self.next_cmd_id = 1
        self.ack_waiters = {}       # command id -> callback
        self.quitting = False
        self.replaced = False       # another bridge took the name: the scripts are now its own
        self.last_output = None
        self.last_overview = None
        self.view_v3 = Gio.DBusNodeInfo.new_for_xml(VIEW_V3_XML).interfaces[0]
        self.view_v2 = Gio.DBusNodeInfo.new_for_xml(VIEW_V2_XML).interfaces[0]

        bridge_iface = Gio.DBusNodeInfo.new_for_xml(BRIDGE_XML).interfaces[0]
        register_object(self.bus, "/Bridge", bridge_iface, self._on_bridge_call)
        Gio.bus_own_name_on_connection(self.bus, "org.kwinir.Bridge",
                                       Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
                                       self._on_bridge_name, self._on_bridge_name_lost)
        Gio.bus_watch_name_on_connection(self.bus, "org.kde.KWin", Gio.BusNameWatcherFlags.NONE,
                                         self._on_kwin_appeared, self._on_kwin_vanished)
        GLib.timeout_add(KWIN_STATE_INTERVAL_MS, self._poll_kwin_state)
        GLib.timeout_add(POLL_HEARTBEAT_MS, self._poll_heartbeat)
        if tiling_enabled:
            self._watch_stdin()

        if jobs_enabled:
            server = Gio.DBusNodeInfo.new_for_xml(SERVER_XML)
            for iface in server.interfaces:
                register_object(self.bus, "/JobViewServer", iface, self._on_server_call)
            for name in ("org.kde.JobViewServer", "org.kde.kuiserver"):
                # Queue behind anyone who already has it (plasmashell's tray, if ever added).
                Gio.bus_own_name_on_connection(self.bus, name, Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT,
                                               lambda *_a, n=name: log(f"owns {n}"),
                                               lambda *_a, n=name: log(f"does not own {n} (someone else does)"))
            self.bus.signal_subscribe("org.freedesktop.Notifications", "org.freedesktop.Notifications",
                                      "ActionInvoked", "/org/freedesktop/Notifications", None,
                                      Gio.DBusSignalFlags.NONE, self._on_action_invoked)
            self.bus.signal_subscribe("org.freedesktop.Notifications", "org.freedesktop.Notifications",
                                      "NotificationClosed", "/org/freedesktop/Notifications", None,
                                      Gio.DBusSignalFlags.NONE, self._on_notification_closed)

    # -- fullscreen (KWin script) ---------------------------------------------
    def _on_bridge_name(self, *_args):
        self.bridge_name_owned = True
        emit({"type": "ready"})
        if self.kwin_present:
            self.load_script()

    def _on_bridge_name_lost(self, *_args):
        self.bridge_name_owned = False
        self.replaced = True   # KWin port: the winner reloaded the scripts by name; don't unload them
        log("lost org.kwinir.Bridge (another bridge replaced this one)")
        self.quit()

    def _on_kwin_appeared(self, *_args):
        self.kwin_present = True
        if self.bridge_name_owned:
            self.load_script()
        self._poll_kwin_state()

    def _on_kwin_vanished(self, *_args):
        if self.kwin_present:
            emit({"type": "fullscreen", "value": False})
            emit({"type": "capture", "value": False})
            if self.tiling:
                emit({"type": "tiling", "v": 1, "enabled": False, "outputs": {}})
        self.kwin_present = False
        self.script_loaded = False
        self.tiling_loaded = False
        self.held_poll = None
        self.last_output = None
        self.last_overview = None

    # -- KWin state (focused output, overview) ----------------------------------
    def _poll_kwin_state(self):
        if self.kwin_present:
            self.bus.call("org.kde.KWin", "/KWin", "org.kde.KWin", "activeOutputName", None,
                          GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, NOTIFY_TIMEOUT_MS,
                          None, self._on_output_reply)
            self.bus.call("org.kde.KWin", "/Effects", "org.freedesktop.DBus.Properties", "Get",
                          GLib.Variant("(ss)", ("org.kde.kwin.Effects", "activeEffects")),
                          GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, NOTIFY_TIMEOUT_MS,
                          None, self._on_effects_reply)
        return GLib.SOURCE_CONTINUE

    def _on_output_reply(self, bus, result):
        try:
            name = bus.call_finish(result).unpack()[0]
        except GLib.Error:
            return
        if name:
            self.last_output = name
            emit({"type": "output", "value": name})

    def _on_effects_reply(self, bus, result):
        try:
            effects = bus.call_finish(result).unpack()[0]
        except GLib.Error:
            return
        self.last_overview = "overview" in effects
        emit({"type": "overview", "value": self.last_overview})

    def _kwin(self, path, iface, method, args, sig, reply):
        return self.bus.call_sync("org.kde.KWin", path, iface, method,
                                  GLib.Variant(sig, args) if sig else None,
                                  GLib.VariantType(reply) if reply else None,
                                  Gio.DBusCallFlags.NONE, NOTIFY_TIMEOUT_MS, None)

    def _load_one(self, path, name):
        loaded = self._kwin("/Scripting", "org.kde.kwin.Scripting", "isScriptLoaded",
                            (name,), "(s)", "(b)").unpack()[0]
        if loaded:
            self._kwin("/Scripting", "org.kde.kwin.Scripting", "unloadScript", (name,), "(s)", "(b)")
        script_id = self._kwin("/Scripting", "org.kde.kwin.Scripting", "loadScript",
                               (path, name), "(ss)", "(i)").unpack()[0]
        if script_id < 0:
            log(f"KWin refused {name}")
            return False
        return True

    def load_script(self):
        try:
            if not self._load_one(FULLSCREEN_SCRIPT, SCRIPT_NAME):
                return
            # KWin port: the tiling script rides along when enabled; otherwise sweep up the
            # global shortcuts a previous tiling run left behind (kglobalaccel keeps them).
            if self.tiling:
                self.config_sent = False
                if self.quicktile:
                    self.release_quicktile()
                else:
                    self.restore_quicktile()
                self.tiling_loaded = self._load_one(TILING_SCRIPT, TILING_NAME)
            else:
                self.unregister_tiling_shortcuts()
                self.restore_quicktile()
            # Not /Scripting/Script<id>.run: KWin numbers a new script by the current
            # script count, so after any unload the id can equal a live script's and
            # its D-Bus path is already taken — run() then hits that other script and
            # ours never starts. Scripting.start() runs every loaded, stopped script.
            self._kwin("/Scripting", "org.kde.kwin.Scripting", "start", None, None, None)
            self.script_loaded = True
        except GLib.Error as e:
            log(f"could not load the KWin script: {e.message}")

    def unload_script(self):
        if not self.script_loaded or self.replaced:
            return
        for name in (SCRIPT_NAME, TILING_NAME):
            try:
                self._kwin("/Scripting", "org.kde.kwin.Scripting", "unloadScript", (name,), "(s)", "(b)")
            except GLib.Error:
                pass
        self.script_loaded = False
        self.tiling_loaded = False

    # -- KWin port: tiling ------------------------------------------------------
    def _ga(self, method, args, sig, reply):
        return self.bus.call_sync("org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel", method,
                                  GLib.Variant(sig, args), GLib.VariantType(reply), Gio.DBusCallFlags.NONE,
                                  NOTIFY_TIMEOUT_MS, None).unpack()[0]

    def _quicktile_keys(self, name, friendly, keys=None):
        aid = ["kwin", name, "KWin", friendly]
        if keys is None:
            return list(self._ga("shortcut", (aid,), "(as)", "(ai)"))
        return list(self._ga("setShortcut", (aid, keys, 4), "(asaiu)", "(ai)"))   # 4 = NoAutoloading

    def _read_released(self):
        try:
            with open(STATE_FILE) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write_released(self, data):
        try:
            if data:
                os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
                with open(STATE_FILE, "w") as f:
                    json.dump(data, f)
            elif os.path.exists(STATE_FILE):
                os.remove(STATE_FILE)
        except OSError as e:
            log(f"could not update {STATE_FILE}: {e}")

    def release_quicktile(self):
        """Free the stock Meta+arrow quick-tile keys for the tiler. Originals are saved first."""
        saved = self._read_released()
        try:
            for name, friendly, stock in QUICKTILE:
                cur = self._quicktile_keys(name, friendly)
                if name not in saved and stock in cur:
                    saved[name] = cur
                    self._write_released(saved)
                if name in saved and cur:
                    self._quicktile_keys(name, friendly, [])
        except GLib.Error as e:
            log(f"could not release the quick-tile keys: {e.message}")

    def restore_quicktile(self):
        """Give the quick-tile keys back (also sweeps up after a bar that died while tiling)."""
        saved = self._read_released()
        if not saved:
            return
        try:
            for name, friendly, _stock in QUICKTILE:
                if name in saved and not self._quicktile_keys(name, friendly):   # not rebound meanwhile
                    self._quicktile_keys(name, friendly, [int(k) for k in saved[name]])
            self._write_released({})
        except GLib.Error as e:
            log(f"could not restore the quick-tile keys: {e.message}")

    def unregister_tiling_shortcuts(self):
        """kglobalaccel keeps a script's shortcuts after it unloads; remove ours."""
        try:
            names = self.bus.call_sync("org.kde.kglobalaccel", "/component/kwin",
                                       "org.kde.kglobalaccel.Component", "shortcutNames", None,
                                       GLib.VariantType("(as)"), Gio.DBusCallFlags.NONE,
                                       NOTIFY_TIMEOUT_MS, None).unpack()[0]
        except GLib.Error:
            return
        for name in names:
            if name.startswith(TILING_PREFIX):
                try:
                    self.bus.call_sync("org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel",
                                       "unregister", GLib.Variant("(ss)", ("kwin", name)),
                                       GLib.VariantType("(b)"), Gio.DBusCallFlags.NONE,
                                       NOTIFY_TIMEOUT_MS, None)
                except GLib.Error:
                    pass

    def _watch_stdin(self):
        self.stdin = Gio.DataInputStream.new(Gio.UnixInputStream.new(0, False))
        self._read_stdin()

    def _read_stdin(self):
        self.stdin.read_line_async(GLib.PRIORITY_DEFAULT, None, self._on_stdin_line)

    def _on_stdin_line(self, stream, result):
        try:
            line, _length = stream.read_line_finish_utf8(result)
        except GLib.Error:
            line = None
        if line is None:
            return   # the bar closed stdin; PR_SET_PDEATHSIG ends us if it died
        if len(line) <= 65536:
            self._handle_bar_message(line)
        self._read_stdin()

    def _handle_bar_message(self, line):
        try:
            msg = json.loads(line)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "tiling-config":
            cfg = clean_tiling_config(msg.get("config"))
            if cfg is None:
                return
            self.tiling_config = cfg
            if self.config_sent:   # script already running: push the change
                self.cmd_queue = [c for c in self.cmd_queue if c["name"] != "config"]
                self._enqueue("config", cfg)
            else:
                self._flush_poll()
        elif msg.get("type") == "tiling-command":
            cmd = clean_tiling_command(msg)
            if cmd is not None and len(self.cmd_queue) < 32:
                self._enqueue(*cmd)

    def _enqueue(self, name, arg=None, on_ack=None):
        cid = self.next_cmd_id
        self.next_cmd_id += 1
        if on_ack is not None:
            self.ack_waiters[cid] = on_ack
        self.cmd_queue.append({"id": cid, "type": "cmd", "name": name, "arg": arg})
        self._flush_poll()

    def _flush_poll(self):
        if self.held_poll is None:
            return
        cmd = None
        if not self.config_sent and self.tiling_config is not None:
            cmd = {"id": 0, "type": "cmd", "name": "config", "arg": self.tiling_config}
            self.config_sent = True
        elif self.cmd_queue and (self.config_sent or self.quitting):
            cmd = self.cmd_queue.pop(0)
        if cmd is None:
            return
        inv, self.held_poll = self.held_poll, None
        inv.return_value(GLib.Variant("(s)", (json.dumps(cmd),)))

    def _poll_heartbeat(self):
        if self.held_poll is not None:
            inv, self.held_poll = self.held_poll, None
            inv.return_value(GLib.Variant("(s)", (json.dumps({"type": "noop"}),)))
        return GLib.SOURCE_CONTINUE

    def _on_bridge_call(self, conn, sender, path, iface, method, params, invocation):
        if method == "NextCommand":
            # KWin port: the tiling script's long-poll (see module docstring).
            if self.held_poll is not None:   # a stale poll from a reloaded script
                self._poll_heartbeat()
            self.held_poll = invocation
            self._flush_poll()
            return
        if method == "Ack":
            try:
                ack = json.loads(params.unpack()[0])
                waiter = self.ack_waiters.pop(ack.get("id"), None) if isinstance(ack, dict) else None
            except (ValueError, TypeError):
                waiter = None
            if waiter is not None:
                waiter()
            invocation.return_value(None)
            return
        if method != "Event":
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
            return
        try:
            event = json.loads(params.unpack()[0])
        except (ValueError, TypeError):
            event = None
        # Only whitelisted events reach the bar, rebuilt from checked fields.
        if isinstance(event, dict) and event.get("type") in ("fullscreen", "capture") and isinstance(event.get("value"), bool):
            emit({"type": event["type"], "value": event["value"]})
        elif isinstance(event, dict) and event.get("type") == "tiling" and self.tiling:
            report = clean_tiling_report(event)
            if report is not None:
                emit(report)
        invocation.return_value(None)

    # -- job view server ------------------------------------------------------
    def _on_server_call(self, conn, sender, path, iface, method, params, invocation):
        if method != "requestView":
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
            return
        args = params.unpack()
        if iface == "org.kde.JobViewServerV2":
            desktop_entry, capabilities, hints = args
            app_name, app_icon = app_info_for(desktop_entry)
            immediate = bool(hints.get("immediate", False))
            v3 = True
        else:
            app_name, app_icon, capabilities = args
            desktop_entry, immediate, v3 = "", False, False
        view_path = f"/JobViewServer/JobView_{self.next_job}"
        self.next_job += 1
        job = Job(self, view_path, sender, desktop_entry, app_name or "Transfer", app_icon,
                  capabilities, v3, immediate)
        job.reg_id = register_object(self.bus, view_path, self.view_v3 if v3 else self.view_v2,
                                     self._on_view_call)
        job.watch_id = Gio.bus_watch_name_on_connection(self.bus, sender, Gio.BusNameWatcherFlags.NONE,
                                                        None, lambda *_a, j=job: j.terminate(KJOB_KILLED, ""))
        self.jobs[view_path] = job
        emit({"type": "jobs", "count": len(self.jobs)})
        invocation.return_value(GLib.Variant("(o)", (view_path,)))

    def _on_view_call(self, conn, sender, path, iface, method, params, invocation):
        job = self.jobs.get(path)
        if job is None or sender != job.sender:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "not your job view")
            return
        args = params.unpack()
        reply = None
        if method == "update":
            job.update(dict(args[0]))
        elif method == "terminate":
            if iface == "org.kde.JobViewV3":
                job.terminate(int(args[0]), args[1])
            else:
                job.terminate(0 if not args[0] else 2, args[0])
        elif method == "setSuspended":
            job.update({"suspended": bool(args[0])})
        elif method in ("setTotalAmount", "setProcessedAmount"):
            unit = {"bytes": "Bytes", "files": "Files", "dirs": "Directories"}.get(args[1], "Items")
            prefix = "total" if method == "setTotalAmount" else "processed"
            job.update({prefix + unit: int(args[0])})
        elif method == "setPercent":
            job.update({"percent": int(args[0])})
        elif method == "setSpeed":
            job.update({"speed": int(args[0])})
        elif method == "setInfoMessage":
            job.update({"infoMessage": args[0]})
        elif method == "setDescriptionField":
            n = int(args[0]) + 1
            job.update({f"descriptionLabel{n}": args[1], f"descriptionValue{n}": args[2]})
            reply = GLib.Variant("(b)", (True,))
        elif method == "clearDescriptionField":
            n = int(args[0]) + 1
            job.state.pop(f"descriptionLabel{n}", None)
            job.state.pop(f"descriptionValue{n}", None)
        elif method == "setDestUrl":
            job.update({"destUrl": str(args[0])})
        invocation.return_value(reply)

    def forget_job(self, job):
        self.jobs.pop(job.path, None)
        for nid in [k for k, v in self.by_notif.items() if v is job]:
            self.by_notif.pop(nid, None)
        if job.watch_id:
            Gio.bus_unwatch_name(job.watch_id)
            job.watch_id = 0
        if job.reg_id:
            # Let the client's last call finish before the object goes away.
            reg = job.reg_id
            job.reg_id = 0
            GLib.timeout_add(2000, lambda: (self.bus.unregister_object(reg), False)[1])
        emit({"type": "jobs", "count": len(self.jobs)})

    # -- notifications --------------------------------------------------------
    def notify(self, replaces, app_name, app_icon, summary, body, actions, hints, urgency, timeout):
        hints = dict(hints)
        hints["urgency"] = GLib.Variant("y", urgency)
        try:
            reply = self.bus.call_sync(
                "org.freedesktop.Notifications", "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications", "Notify",
                GLib.Variant("(susssasa{sv}i)", (app_name or "", int(replaces), app_icon or "",
                                                  summary, body, actions, hints, int(timeout))),
                GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, NOTIFY_TIMEOUT_MS, None)
        except GLib.Error as e:
            log(f"Notify failed: {e.message}")
            return 0
        return reply.unpack()[0]

    def close_notification(self, nid):
        self.by_notif.pop(nid, None)
        try:
            self.bus.call_sync("org.freedesktop.Notifications", "/org/freedesktop/Notifications",
                               "org.freedesktop.Notifications", "CloseNotification",
                               GLib.Variant("(u)", (int(nid),)), None, Gio.DBusCallFlags.NONE,
                               NOTIFY_TIMEOUT_MS, None)
        except GLib.Error:
            pass

    def _job_for_notif(self, nid):
        job = self.by_notif.get(nid)
        if job is None:
            job = next((j for j in self.jobs.values() if j.notif_id == nid), None)
            if job is not None:
                self.by_notif[nid] = job
        return job

    def _on_action_invoked(self, conn, sender, path, iface, signal_name, params):
        nid, key = params.unpack()
        job = self._job_for_notif(nid)
        if job is not None:
            job.action(key)
        elif key == "open" and nid in self.finished_folders:
            try:
                Gio.AppInfo.launch_default_for_uri(self.finished_folders.pop(nid), None)
            except GLib.Error as e:
                log(f"could not open folder: {e.message}")

    def _on_notification_closed(self, conn, sender, path, iface, signal_name, params):
        nid, reason = params.unpack()
        self.finished_folders.pop(nid, None)
        job = self._job_for_notif(nid)
        if job is not None and reason == 2:   # dismissed by the user: stop showing this job
            job.dismissed = True
            job.notif_id = 0
            self.by_notif.pop(nid, None)

    # -- lifecycle ------------------------------------------------------------
    def quit(self):
        if self.quitting:
            return GLib.SOURCE_REMOVE
        self.quitting = True
        for job in list(self.jobs.values()):
            if job.notif_id:
                self.close_notification(job.notif_id)
        # KWin port: have the tiling script give every window it minimized back before it is
        # unloaded (it can't clean up after itself: scripts have no unload hook).
        if self.tiling_loaded and self.kwin_present and not self.replaced:
            self._enqueue("release-all", None, on_ack=self._finish_quit)
            GLib.timeout_add(RELEASE_WAIT_MS, self._finish_quit)
            return GLib.SOURCE_REMOVE
        self._finish_quit()
        return GLib.SOURCE_REMOVE

    def _finish_quit(self):
        if getattr(self, "_finished", False):
            return GLib.SOURCE_REMOVE
        self._finished = True
        was_tiling = self.tiling_loaded
        self.unload_script()
        if was_tiling and not self.replaced:
            self.unregister_tiling_shortcuts()
            self.restore_quicktile()
        self.loop.quit()
        return GLib.SOURCE_REMOVE


def main():
    # Die with the bar even if it is killed outright (PR_SET_PDEATHSIG).
    try:
        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGTERM)
    except OSError:
        pass
    bridge = Bridge(jobs_enabled="--jobs" in sys.argv[1:], tiling_enabled="--tiling" in sys.argv[1:],
                    quicktile="--quicktile" in sys.argv[1:])
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        unix_signal_add(GLib.PRIORITY_HIGH, signum, bridge.quit)
    bridge.loop.run()


if __name__ == "__main__":
    main()
