pragma Singleton
import Quickshell

Singleton {
    id: root
    /**
     * @param { string } summary 
     * @returns { string }
     */
    function findSuitableMaterialSymbol(summary = "") {
        const defaultType = 'chat';
        if (summary.length === 0) return defaultType;

        const keywordsToTypes = {
            'reboot': 'restart_alt',
            'record': 'screen_record',
            'battery': 'power',
            'power': 'power',
            'screenshot': 'screenshot_monitor',
            'welcome': 'waving_hand',
            'time': 'scheduleb',
            'installed': 'download',
            'configuration reloaded': 'reset_wrench',
            'unable': 'question_mark',
            "couldn't": 'question_mark',
            'config': 'reset_wrench',
            'update': 'update',
            'ai response': 'neurology',
            'control': 'settings',
            'upsca': 'compare',
            'music': 'queue_music',
            'install': 'deployed_code_update',
            'input': 'keyboard_alt',
            'preedit': 'keyboard_alt',
            'startswith:file': 'folder_copy', // Declarative startsWith check
        };

        const lowerSummary = summary.toLowerCase();

        for (const [keyword, type] of Object.entries(keywordsToTypes)) {
            if (keyword.startsWith('startswith:')) {
                const startsWithKeyword = keyword.replace('startswith:', '');
                if (lowerSummary.startsWith(startsWithKeyword)) {
                    return type;
                }
            } else if (lowerSummary.includes(keyword)) {
                return type;
            }
        }

        return defaultType;
    }

    /**
     * @param { number | string | Date } timestamp 
     * @returns { string }
     */
    function getFriendlyNotifTimeString(timestamp) {
        if (!timestamp) return '';
        const messageTime = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - messageTime.getTime();

        // Less than 1 minute
        if (diffMs < 60000)
            return 'Now';

        // Same day - show relative time
        if (messageTime.toDateString() === now.toDateString()) {
            const diffMinutes = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);

            if (diffHours > 0) {
                return `${diffHours}h`;
            } else {
                return `${diffMinutes}m`;
            }
        }

        // Yesterday
        if (messageTime.toDateString() === new Date(now.getTime() - 86400000).toDateString())
            return 'Yesterday';

        // Older dates
        return Qt.formatDateTime(messageTime, "MMMM dd");
    }

    /**
     * KWin port: drop <img> tags whose source isn't local. Qt Quick's styled/rich text
     * fetches http(s) images, so any app or website could make the bar load a remote image
     * the moment a notification arrived (a read receipt / IP leak — verified with a local
     * server). File paths, file:// and inline data:image sources still render.
     */
    function stripRemoteImages(text) {
        return String(text ?? "").replace(/<img\b[^>]*>/gi, tag => {
            const m = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
            const src = m ? String(m[1] ?? m[2] ?? m[3] ?? "").trim() : ""
            return /^(file:|\/(?!\/)|data:image\/)/i.test(src) ? tag : ""
        })
    }

    function processNotificationBody(body, appName) {
        let processedBody = body
        
        // Clean Chromium-based browsers notifications - remove first line
        if (appName) {
            const lowerApp = appName.toLowerCase()
            const chromiumBrowsers = [
                "brave", "chrome", "chromium", "vivaldi", "opera", "microsoft edge"
            ]

            if (chromiumBrowsers.some(name => lowerApp.includes(name))) {
                const lines = body.split('\n\n')

                if (lines.length > 1 && lines[0].startsWith('<a')) {
                    processedBody = lines.slice(1).join('\n\n')
                }
            }
        }

        processedBody = stripRemoteImages(processedBody).replace(/<img/gi, '\n\n<img');
        
        return processedBody
    }
}
