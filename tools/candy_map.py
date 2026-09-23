#!/usr/bin/env python3
"""
Build assets/candy/material-map.json: Material Symbols name -> candy-icons file.

Each Material name lists candy icon names in order of preference; the first
one that exists in /usr/share/icons/candy-icons wins. Names whose only
honest match would be a different concept are left out and keep their
Material glyph — candy-icons has no action set (close, add, arrows, edit,
refresh...) and no weather conditions.

"@pick" targets are burningb95's hand-picked SVGs in assets/candy (see
CandyGlyphs.qml); they win over any candy lookup.

    python3 tools/candy_map.py .     # from the shell root: writes the JSON, prints a report
"""
import json
import os
import sys

CANDY = "/usr/share/icons/candy-icons"

M = {
    # ── hand picks (assets/candy) ───────────────────────────────────────
    "delete_sweep": ["@clear-notifications"],
    "cleaning_services": ["@clear-notifications"],
    "do_not_disturb_on": ["@do-not-disturb"],
    "notifications_paused": ["@do-not-disturb"],
    "notifications_off": ["@do-not-disturb"],
    "gamepad": ["@game-mode"], "sports_esports": ["@game-mode"],
    "videogame_asset": ["@game-mode"], "joystick": ["@game-mode"],
    "calendar_month": ["@calendar"], "calendar_today": ["@calendar"], "today": ["@calendar"],
    # events get their own icon so the Calendar and Events tabs stay distinguishable
    "event": ["office-date"], "event_upcoming": ["office-date"], "event_note": ["office-date"],
    "event_available": ["office-date"], "event_busy": ["office-date"], "event_repeat": ["office-date"],
    "date_range": ["@calendar"], "calendar_view_week": ["@calendar"],
    "calendar_view_month": ["@calendar"], "view_week": ["@calendar"],
    "calculate": ["@calculator"], "functions": ["@calculator"],
    "search": ["@search"], "manage_search": ["@search"], "travel_explore": ["@search"],
    "search_activity": ["@search"], "image_search": ["@search"], "loupe": ["@search"],
    "hourglass_empty": ["@timer"], "hourglass_top": ["@timer"], "timer": ["@timer"],
    "av_timer": ["@timer"], "timelapse": ["@timer"], "timer_off": ["@timer"],
    "timer_10_alt_1": ["@timer"],
    "checklist": ["@todo"], "task_alt": ["@todo"], "task": ["@todo"], "done_all": ["@todo"],
    "rule": ["@todo"], "planner_review": ["@todo"], "remove_done": ["@todo"],

    # ── system / session ────────────────────────────────────────────────
    "settings": ["preferences-system", "systemsettings"],
    "tune": ["utilities-tweak-tool", "preferences-system"],
    "settings_suggest": ["preferences-system"], "rule_settings": ["preferences-system"],
    "display_settings": ["preferences-desktop-display"],
    "video_settings": ["preferences-desktop-multimedia"],
    "power": ["system-shutdown"], "power_settings_new": ["system-shutdown"],
    "settings_power": ["system-shutdown"],
    "logout": ["system-log-out"], "login": ["system-switch-user"],
    "restart_alt": ["system-reboot"], "cached": ["system-reboot"],
    "bedtime": ["system-suspend"], "sleep": ["system-suspend"],
    # candy's system-lock-screen is a person silhouette; keepassxc is a keyhole
    "lock": ["keepassxc"], "lock_clock": ["keepassxc"],
    "update": ["system-software-update"], "system_update": ["system-software-update"],
    "system_update_alt": ["system-software-update"], "upgrade": ["system-software-update"],
    "browser_updated": ["system-software-update"],
    "deployed_code_update": ["system-software-update"],
    "store": ["software-store", "software-center"],
    "terminal": ["utilities-terminal", "terminal"],
    "code": ["applications-development"], "code_blocks": ["applications-development"],
    "api": ["applications-development"], "script": ["applications-development"],
    "build": ["applications-utilities"], "construction": ["applications-utilities"],
    "service_toolbox": ["applications-utilities"], "hardware": ["applications-utilities"],
    "handyman": ["applications-utilities"],
    "extension": ["plugins-desktop"], "extension_off": ["plugins-desktop"],
    "apps": ["org.kde.plasma.kickerdash", "applications-system"],
    "apps_outage": ["org.kde.plasma.kickerdash"],
    "monitor_heart": ["utilities-system-monitor"], "monitoring": ["utilities-system-monitor"],
    "speed": ["utilities-system-monitor"], "memory": ["utilities-system-monitor"],
    "memory_alt": ["utilities-system-monitor"], "developer_board": ["utilities-system-monitor"],
    "bar_chart": ["utilities-system-monitor"], "show_chart": ["utilities-system-monitor"],
    "analytics": ["utilities-system-monitor"], "vitals": ["utilities-system-monitor"],
    "hard_drive": ["drive-harddisk"], "storage": ["drive-harddisk"],
    "archive": ["utilities-file-archiver"], "inventory_2": ["utilities-file-archiver"],
    "package": ["utilities-file-archiver"],
    "bug_report": ["utilities-log-viewer"], "history_edu": ["utilities-log-viewer"],

    # ── files ───────────────────────────────────────────────────────────
    "folder": ["folder"], "folder_open": ["folder-open"], "topic": ["folder"],
    "folder_special": ["folder-favorites"], "folder_copy": ["folder"],
    "create_new_folder": ["folder-new", "folder-add"], "folder_off": ["folder-locked"],
    "download": ["folder-download"], "drive_file_move": ["folder-download"],
    "home": ["user-home"],
    "delete": ["user-trash"], "delete_forever": ["user-trash-full"],
    "history": ["document-open-recent", "folder-recent"],
    "restore": ["document-open-recent"],
    "description": ["accessories-text-editor"], "article": ["accessories-text-editor"],
    "draft": ["accessories-text-editor"], "file_present": ["accessories-text-editor"],
    "note": ["notes", "knotes"], "notes": ["notes", "knotes"],
    "sticky_note_2": ["notes", "knotes"], "edit_note": ["notes", "knotes"],
    "content_copy": ["edit-copy"],
    "content_paste": ["klipper", "copyq"], "assignment": ["klipper", "copyq"],
    "content_paste_go": ["klipper"], "content_paste_search": ["klipper"],
    "bookmark": ["bookmarks"], "bookmark_add": ["bookmarks"], "bookmark_heart": ["bookmarks"],
    "favorite": ["favorites"], "star": ["favorites"], "stars": ["favorites"],
    "award_star": ["favorites"],
    "picture_as_pdf": ["document-viewer"],
    "print": ["printer"],

    # ── media ───────────────────────────────────────────────────────────
    "music_note": ["multimedia-audio-player"], "library_music": ["folder-music"],
    "queue_music": ["multimedia-audio-player"], "album": ["multimedia-audio-player"],
    "artist": ["multimedia-audio-player"], "lyrics": ["multimedia-audio-player"],
    "music_cast": ["multimedia-audio-player"], "audio_file": ["multimedia-audio-player"],
    "movie": ["multimedia-video-player"], "slideshow": ["multimedia-video-player"],
    "videocam": ["camera-on"], "screen_record": ["simplescreenrecorder", "kooha", "obs"],
    "image": ["image-viewer", "multimedia-photo-viewer"], "photo": ["image-viewer"],
    "photo_library": ["multimedia-photo-manager"], "collections": ["multimedia-photo-manager"],
    "perm_media": ["multimedia-photo-manager"], "add_photo_alternate": ["image-viewer"],
    "landscape": ["image-viewer"],
    "wallpaper": ["preferences-desktop-wallpaper"],
    "wallpaper_slideshow": ["preferences-desktop-wallpaper"],
    "camera": ["accessories-camera"], "photo_camera": ["accessories-camera"],
    "screenshot": ["accessories-screenshot"], "screenshot_region": ["accessories-screenshot"],
    "screenshot_monitor": ["accessories-screenshot"], "screenshot_frame_2": ["accessories-screenshot"],
    "play_arrow": ["media-playback-playing"], "play_circle": ["media-playback-playing"],
    "resume": ["media-playback-playing"], "play_pause": ["media-playback-playing"],
    "pause": ["media-playback-paused"], "pause_circle": ["media-playback-paused"],
    "motion_photos_paused": ["media-playback-paused"],
    "stop": ["media-playback-stopped"],
    "equalizer": ["easyeffects", "multimedia-volume-control"],
    "graphic_eq": ["easyeffects", "multimedia-volume-control"],
    "instant_mix": ["multimedia-volume-control"],
    "volume_up": ["audio-volume-high"], "speaker": ["audio-volume-high"],
    "media_output": ["audio-volume-high"], "volume_down": ["audio-volume-low"],
    "volume_off": ["audio-volume-muted"], "volume_mute": ["audio-volume-muted"],
    "mic": ["mic-on"], "keyboard_voice": ["mic-on"], "mic_external_on": ["mic-on"],
    "record_voice_over": ["mic-on"], "mic_off": ["mic-off"],
    "headphones": ["audio-headphones"], "headset": ["audio-headphones"],

    # ── network ─────────────────────────────────────────────────────────
    "wifi": ["network-wireless-signal-excellent"], "network_wifi": ["network-wireless-signal-excellent"],
    "signal_wifi_4_bar": ["network-wireless-signal-excellent"],
    "network_wifi_3_bar": ["network-wireless-signal-good"],
    "network_wifi_2_bar": ["network-wireless-signal-ok"],
    "network_wifi_1_bar": ["network-wireless-signal-weak"],
    "signal_wifi_0_bar": ["network-wireless-signal-none"],
    "wifi_off": ["network-wireless-off"], "signal_wifi_off": ["network-wireless-off"],
    "signal_wifi_bad": ["network-wireless-disconnected"],
    "signal_wifi_statusbar_not_connected": ["network-wireless-disconnected"],
    "wifi_find": ["network-wireless-acquiring"],
    "wifi_tethering": ["network-wireless-available"],
    "lan": ["network-wired"], "settings_ethernet": ["network-wired"],
    "bluetooth": ["network-bluetooth"], "bluetooth_connected": ["network-bluetooth-activated"],
    "bluetooth_disabled": ["network-bluetooth-inactive-symbolic"],
    "security": ["preferences-system-privacy"], "shield": ["preferences-system-privacy"],
    "policy": ["preferences-system-privacy"], "privacy": ["preferences-system-privacy"],
    "shield_lock": ["preferences-system-privacy"],
    "admin_panel_settings": ["preferences-system-privacy"],
    "public": ["globe", "internet-web-browser"], "language": ["preferences-desktop-locale", "globe"],
    "translate": ["translator"],
    "web": ["internet-web-browser"], "http": ["internet-web-browser"],
    "newspaper": ["akregator", "internet-news-reader"], "news": ["akregator", "internet-news-reader"],
    "devices": ["kdeconnect"],

    # ── notifications ───────────────────────────────────────────────────
    "notifications": ["notifications"], "notifications_none": ["notification-inactive"],
    "notifications_active": ["notification-active"], "inbox": ["mail-folder-inbox"],
    "notification_sound": ["preferences-desktop-notification-bell"],

    # ── devices / hardware ──────────────────────────────────────────────
    "keyboard": ["input-keyboard"], "keyboard_alt": ["input-keyboard"],
    "keyboard_hide": ["input-keyboard"],
    "mouse": ["input-mouse"], "left_click": ["input-mouse"],
    "highlight_mouse_cursor": ["preferences-desktop-cursors"],
    "computer": ["computer"], "desktop_windows": ["computer"], "desktop_mac": ["computer"],
    "monitor": ["preferences-desktop-display"], "tv": ["preferences-desktop-display"],
    "laptop": ["computer"],
    "smartphone": ["smartphone"], "phone": ["phone"], "tablet": ["input-tablet"],
    "battery_full": ["battery-full"], "battery_android_full": ["battery-full"],
    "battery_android_frame_full": ["battery-full"],
    "battery_charging_full": ["battery-full-charging"],
    "battery_5_bar": ["battery-080"], "battery_3_bar": ["battery-050"],
    "battery_2_bar": ["battery-030"], "battery_1_bar": ["battery-010"],
    "battery_alert": ["battery-caution"], "battery_saver": ["battery-profile-powersave"],
    "bolt": ["battery-profile-performance"], "electric_bolt": ["battery-profile-performance"],
    "energy_savings_leaf": ["battery-profile-powersave"], "eco": ["battery-profile-powersave"],
    "screen_rotation_alt": ["rotation-allowed"],

    # ── appearance / desktop ────────────────────────────────────────────
    "palette": ["preferences-desktop-color"], "colors": ["preferences-desktop-color"],
    "style": ["preferences-desktop-theme"], "format_paint": ["preferences-desktop-theme"],
    "colorize": ["kcolorchooser", "color-picker"], "format_color_fill": ["kcolorchooser"],
    "invert_colors": ["preferences-desktop-color"],
    "nightlight": ["redshift-status-on"], "night_sight_auto": ["redshift-status-on"],
    "wb_twilight": ["redshift-status-on"],
    "font_download": ["preferences-desktop-font"], "text_fields": ["preferences-desktop-font"],
    "format_size": ["preferences-desktop-font"], "text_format": ["preferences-desktop-font"],
    "serif": ["preferences-desktop-font"],
    "widgets": ["plugins-desktop"], "dashboard": ["org.kde.plasma.kickerdash"],
    "dashboard_customize": ["org.kde.plasma.kickerdash"],
    "space_dashboard": ["org.kde.plasma.kickerdash"],
    "window": ["preferences-system-windows"], "select_window": ["preferences-system-windows"],
    "workspaces": ["preferences-desktop-workspaces"], "overview": ["preferences-desktop-workspaces"],
    "overview_key": ["preferences-desktop-workspaces"],
    "view_carousel": ["preferences-desktop-workspaces"],
    "animation": ["preferences-system-windows-effect-flipswitch"],
    "shadow": ["preferences-tweaks-shadows"],
    "accessibility": ["preferences-desktop-accessibility"],

    # ── people / misc ───────────────────────────────────────────────────
    "person": ["preferences-desktop-user"], "account_circle": ["preferences-desktop-user"],
    "account_box": ["preferences-desktop-user"], "manage_accounts": ["system-users"],
    "badge": ["preferences-desktop-user"], "group": ["system-users"], "groups": ["system-users"],
    "key": ["password", "seahorse"], "password": ["password", "seahorse"],
    "password_2": ["password"], "key_vertical": ["password"], "key_off": ["password"],
    "school": ["applications-education"], "auto_stories": ["accessories-dictionary", "calibre"],
    "library_books": ["calibre"], "dictionary": ["accessories-dictionary"],
    "science": ["applications-science"],
    "info": ["help-info", "help-about"], "help": ["help-browser", "help-faq"],
    "question_mark": ["help-faq"],
    "error": ["system-error"], "dangerous": ["system-error"],
    "schedule": ["clock", "accessories-clock"], "alarm": ["alarm-clock", "kalarm"],
    "nest_clock_farsight_analog": ["clock"], "avg_pace": ["clock"], "pace": ["clock"],
    # AI glyphs (neurology, psychology, smart_toy, assistant) stay Material: candy's
    # only candidate, "assistant", is Qt Assistant's logo.
    "map": ["gnome-maps", "marble"], "place": ["gnome-maps"], "location_on": ["gnome-maps"],
    "my_location": ["gnome-maps"], "near_me": ["gnome-maps"],
}


def main():
    out_root = sys.argv[1] if len(sys.argv) > 1 else "."
    idx = {}
    for ctx in ("status", "devices", "preferences", "places", "mimetypes", "apps"):
        for dp, _dn, fns in os.walk(os.path.join(CANDY, ctx)):
            for f in fns:
                if f.endswith(".svg"):
                    idx.setdefault(f[:-4], os.path.relpath(os.path.join(dp, f), CANDY))
    out, missing = {}, []
    for mat, cands in M.items():
        hit = next((c if c.startswith("@") else idx[c] for c in cands
                    if c.startswith("@") or c in idx), None)
        if hit:
            out[mat] = hit
        else:
            missing.append(mat)
    dest = os.path.join(out_root, "assets/candy/material-map.json")
    with open(dest, "w") as fh:
        json.dump(dict(sorted(out.items())), fh, indent=1)
        fh.write("\n")
    print(f"mapped {len(out)} names -> {dest}")
    if missing:
        print("no candy match (left as Material):", " ".join(missing))


if __name__ == "__main__":
    main()
