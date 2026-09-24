pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Widgets
import qs
import qs.modules.common
import qs.modules.common.widgets
import qs.services
import "root:"

/**
 * KWin port: Quick Note holds up to 5 notes, stepped through with arrow buttons,
 * modelled on burningb95's Garuda Neon Sidebar notes:
 *   - pinned notes sit first; opening the sidebar shows the first pinned note,
 *     otherwise a fresh blank note (one blank "compose" slot is kept while there
 *     is room);
 *   - notes save as you type (debounced), blank unpinned notes are never stored.
 * Stored in <state>/quicknotes.json, separate from the shared Notepad service.
 */
Item {
    id: root
    implicitHeight: card.implicitHeight

    readonly property int maxNotes: 5
    readonly property string storePath: `${Directories.stateUserPath}/quicknotes.json`

    property var notes: []          // [{ text, pinned, updated }]
    property int index: 0
    property bool loaded: false
    property bool _settingText: false
    readonly property var current: notes[index] ?? ({ text: "", pinned: false })
    readonly property bool currentIsBlank: (current.text ?? "") === "" && !current.pinned

    function _pinnedCount(list): int {
        let n = 0
        while (n < list.length && list[n].pinned) n++
        return n
    }

    // Pinned first (stable), at most maxNotes, exactly one blank compose slot while there's room.
    function _normalized(list): var {
        const pinned = list.filter(n => n.pinned)
        let seenBlank = false
        const rest = list.filter(n => {
            if (n.pinned) return false
            if ((n.text ?? "") !== "") return true
            if (seenBlank) return false   // erased notes don't pile up as extra blanks
            seenBlank = true
            return true
        })
        let out = pinned.concat(rest).slice(0, root.maxNotes)
        const hasBlank = out.some(n => !n.pinned && (n.text ?? "") === "")
        if (!hasBlank && out.length < root.maxNotes) {
            const pc = root._pinnedCount(out)
            out.splice(pc, 0, { text: "", pinned: false, updated: Date.now() })
        }
        return out
    }

    // What opening the sidebar lands on: first pinned note, else the blank note,
    // else (all 5 used) the most recently edited one.
    function resetView(): void {
        root.notes = root._normalized(root.notes)
        if (root._pinnedCount(root.notes) > 0) {
            root.index = 0
        } else {
            const blank = root.notes.findIndex(n => !n.pinned && (n.text ?? "") === "")
            if (blank >= 0) {
                root.index = blank
            } else {
                let best = 0
                for (let i = 1; i < root.notes.length; i++)
                    if ((root.notes[i].updated ?? 0) > (root.notes[best].updated ?? 0)) best = i
                root.index = best
            }
        }
        root._showCurrent()
    }

    function _showCurrent(): void {
        root._settingText = true
        textArea.text = root.current.text ?? ""
        root._settingText = false
    }

    function go(step: int): void {
        const next = Math.max(0, Math.min(root.notes.length - 1, root.index + step))
        if (next === root.index) return
        root.index = next
        root._showCurrent()
    }

    function setText(text: string): void {
        const list = root.notes.slice()
        if (root.index < 0 || root.index >= list.length) return
        list[root.index] = Object.assign({}, list[root.index], { text: text, updated: Date.now() })
        root.notes = list
        saveTimer.restart()
    }

    function togglePin(): void {
        const list = root.notes.slice()
        const note = Object.assign({}, list[root.index], { pinned: !list[root.index].pinned })
        list.splice(root.index, 1)
        // Pinning moves the note to the front; unpinning puts it right after the pinned block.
        const at = note.pinned ? 0 : root._pinnedCount(list)
        list.splice(at, 0, note)
        root.notes = root._normalized(list)
        root.index = Math.max(0, root.notes.indexOf(note))
        root._showCurrent()
        root.save()
    }

    function newNote(): void {
        root.notes = root._normalized(root.notes)
        const blank = root.notes.findIndex(n => !n.pinned && (n.text ?? "") === "")
        if (blank < 0) return // all 5 used
        root.index = blank
        root._showCurrent()
        textArea.forceActiveFocus()
    }

    function deleteCurrent(): void {
        const list = root.notes.slice()
        list.splice(root.index, 1)
        root.notes = root._normalized(list)
        root.index = Math.max(0, Math.min(root.index, root.notes.length - 1))
        root._showCurrent()
        root.save()
    }

    // Ctrl+Enter: save now and leave the editor (the original Quick Note's shortcut).
    property bool justSaved: false
    function finish(): void {
        root.save()
        textArea.focus = false
        root.justSaved = true
        savedFlash.restart()
    }

    function save(): void {
        if (!root.loaded) return
        saveTimer.stop()
        const stored = root.notes
            .filter(n => n.pinned || (n.text ?? "") !== "")
            .map(n => ({ text: n.text ?? "", pinned: !!n.pinned, updated: n.updated ?? 0 }))
        store.setText(JSON.stringify({ version: 1, notes: stored }, null, 2))
    }

    Timer {
        id: savedFlash
        interval: 1500
        onTriggered: root.justSaved = false
    }

    Timer {
        id: saveTimer
        interval: 500
        onTriggered: root.save()
    }

    FileView {
        id: store
        path: Qt.resolvedUrl(root.storePath)
        printErrors: false
        onLoaded: {
            let list = []
            try {
                const data = JSON.parse(store.text())
                list = Array.isArray(data?.notes) ? data.notes : []
            } catch (e) {
                console.warn("[QuickNote] unreadable quicknotes.json, starting empty:", e.message)
            }
            root.notes = list
                .filter(n => n && typeof n === "object")
                .map(n => ({ text: String(n.text ?? ""), pinned: !!n.pinned, updated: Number(n.updated) || 0 }))
            root.loaded = true
            root.resetView()
        }
        onLoadFailed: error => {
            root.notes = []
            root.loaded = true
            root.resetView()
        }
    }

    Connections {
        target: GlobalStates
        function onSidebarLeftOpenChanged() {
            if (GlobalStates.sidebarLeftOpen) {
                if (root.loaded) root.resetView()
            } else {
                textArea.focus = false
                root.save()
            }
        }
    }

    Component.onDestruction: if (saveTimer.running) root.save()

    component NoteButton: RippleButton {
        id: nb
        property string glyph
        property string tipText
        property bool lit: false
        implicitWidth: 24; implicitHeight: 24
        buttonRadius: Appearance.inirEverywhere ? Appearance.inir.roundingSmall : Appearance.rounding.full
        colBackground: "transparent"
        colBackgroundHover: Appearance.inirEverywhere ? Appearance.inir.colLayer2Hover
            : Appearance.auroraEverywhere ? Appearance.aurora.colSubSurfaceHover : Appearance.colLayer2Hover
        colRipple: Appearance.inirEverywhere ? Appearance.inir.colLayer2Active
            : Appearance.auroraEverywhere ? Appearance.aurora.colSubSurfaceActive : Appearance.colLayer2Active
        opacity: enabled ? 1 : 0.35
        Behavior on opacity {
            enabled: Appearance.animationsEnabled
            NumberAnimation { duration: Appearance.animation.elementMoveFast.duration }
        }
        contentItem: Item {
            MaterialSymbol {
                anchors.centerIn: parent
                text: nb.glyph
                iconSize: 14
                fill: nb.lit ? 1 : 0
                color: nb.lit
                    ? (Appearance.inirEverywhere ? Appearance.inir.colPrimary : Appearance.colors.colPrimary)
                    : (Appearance.inirEverywhere ? Appearance.inir.colTextSecondary : Appearance.colors.colSubtext)
            }
        }
        StyledToolTip { text: nb.tipText }
    }

    Rectangle {
        id: card
        anchors.fill: parent
        implicitHeight: col.implicitHeight + 16
        radius: Appearance.angelEverywhere ? Appearance.angel.roundingNormal
            : Appearance.inirEverywhere ? Appearance.inir.roundingNormal
            : Appearance.rounding.normal
        color: "transparent"

        ColumnLayout {
            id: col
            anchors.fill: parent
            anchors.margins: 8
            spacing: 6

            RowLayout {
                Layout.fillWidth: true
                spacing: 2

                // KWin port: candy-icons bijiben (note app) instead of the edit_note glyph;
                // the glyph moved to Events & Reminders (see KWIN_PORT.md).
                IconImage {
                    implicitWidth: 16
                    implicitHeight: 16
                    source: Quickshell.iconPath("bijiben", true)
                }

                StyledText {
                    Layout.leftMargin: 4
                    text: Translation.tr("Quick Note")
                    font.pixelSize: Appearance.font.pixelSize.small
                    font.weight: Font.Medium
                    color: Appearance.inirEverywhere ? Appearance.inir.colText : Appearance.colors.colOnLayer1
                }

                Item { Layout.fillWidth: true }

                NoteButton {
                    glyph: "chevron_left"
                    tipText: Translation.tr("Previous note")
                    enabled: root.index > 0
                    onClicked: root.go(-1)
                }
                StyledText {
                    Layout.minimumWidth: 26
                    horizontalAlignment: Text.AlignHCenter
                    text: `${root.index + 1}/${Math.max(1, root.notes.length)}`
                    font.pixelSize: Appearance.font.pixelSize.smallest
                    color: Appearance.inirEverywhere ? Appearance.inir.colTextSecondary : Appearance.colors.colSubtext
                }
                NoteButton {
                    glyph: "chevron_right"
                    tipText: Translation.tr("Next note")
                    enabled: root.index < root.notes.length - 1
                    onClicked: root.go(1)
                }

                Item { Layout.preferredWidth: 6 }

                NoteButton {
                    glyph: "push_pin"
                    tipText: root.current.pinned ? Translation.tr("Unpin (stop opening on this note)")
                                             : Translation.tr("Pin (open on this note)")
                    lit: !!root.current.pinned
                    enabled: !root.currentIsBlank || root.current.pinned
                    onClicked: root.togglePin()
                }
                NoteButton {
                    glyph: "add"
                    readonly property bool room: root.notes.length < root.maxNotes
                        || root.notes.some(n => !n.pinned && (n.text ?? "") === "")
                    tipText: room ? Translation.tr("New note") : Translation.tr("All %1 notes in use — delete one first").arg(root.maxNotes)
                    enabled: !root.currentIsBlank && room
                    onClicked: root.newNote()
                }
                NoteButton {
                    glyph: "delete"
                    tipText: Translation.tr("Delete this note")
                    enabled: !root.currentIsBlank
                    onClicked: root.deleteCurrent()
                }
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(120, Math.max(60, textArea.implicitHeight + 12))
                Layout.fillHeight: true // KWin port: grow into extra height when sized tall/fill
                radius: Appearance.inirEverywhere ? Appearance.inir.roundingSmall : Appearance.rounding.small
                color: Appearance.inirEverywhere
                    ? (textArea.activeFocus ? Appearance.inir.colLayer2Hover : Appearance.inir.colLayer2)
                    : (textArea.activeFocus ? Appearance.colLayer2Hover : Appearance.colors.colLayer2)
                border.width: Appearance.inirEverywhere ? 1 : (textArea.activeFocus ? 2 : (root.current.pinned ? 1 : 0))
                border.color: Appearance.inirEverywhere ? Appearance.inir.colBorder : Appearance.colors.colPrimary

                Behavior on color {
                    enabled: Appearance.animationsEnabled
                    ColorAnimation { duration: Appearance.animation.elementMoveFast.duration }
                }

                Flickable {
                    anchors.fill: parent
                    anchors.margins: 6
                    contentHeight: textArea.implicitHeight
                    clip: true

                    TextArea {
                        id: textArea
                        width: parent.width
                        placeholderText: root.current.pinned ? "" : Translation.tr("New note…")
                        renderType: Text.NativeRendering
                        wrapMode: TextEdit.Wrap
                        font.pixelSize: Appearance.font.pixelSize.small
                        font.family: Appearance.font.family.main
                        color: Appearance.inirEverywhere ? Appearance.inir.colText : Appearance.colors.colOnLayer2
                        placeholderTextColor: Appearance.inirEverywhere ? Appearance.inir.colTextSecondary : Appearance.colors.colOutline
                        background: null
                        padding: 0

                        onTextChanged: if (!root._settingText && root.loaded) root.setText(text)
                        Keys.onEscapePressed: focus = false
                        Keys.onPressed: (event) => {
                            if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                                    && (event.modifiers & Qt.ControlModifier)) {
                                root.finish()
                                event.accepted = true
                            }
                        }
                    }
                }
            }

            // Hint while typing, brief confirmation after Ctrl+Enter
            StyledText {
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignRight
                visible: opacity > 0
                opacity: textArea.activeFocus || root.justSaved ? 1 : 0
                text: root.justSaved ? Translation.tr("Saved") : Translation.tr("Ctrl+Enter to save")
                font.pixelSize: Appearance.font.pixelSize.smallest
                color: root.justSaved
                    ? (Appearance.inirEverywhere ? Appearance.inir.colPrimary : Appearance.colors.colPrimary)
                    : (Appearance.inirEverywhere ? Appearance.inir.colTextSecondary : Appearance.colors.colOutline)
                Behavior on opacity {
                    enabled: Appearance.animationsEnabled
                    NumberAnimation { duration: Appearance.animation.elementMoveFast.duration }
                }
            }
        }
    }
}
