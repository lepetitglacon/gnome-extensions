import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Types de fenetres qui ne doivent jamais voler le focus (toasts, menus...).
const TRANSIENT_TYPES = [
    Meta.WindowType.NOTIFICATION,
    Meta.WindowType.DESKTOP,
    Meta.WindowType.DOCK,
    Meta.WindowType.SPLASHSCREEN,
    Meta.WindowType.MENU,
    Meta.WindowType.DROPDOWN_MENU,
    Meta.WindowType.POPUP_MENU,
    Meta.WindowType.TOOLTIP,
    Meta.WindowType.COMBO,
    Meta.WindowType.DND,
];

export default class FocusNewWindowExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._ids = [];
        this._savedHandlerIds = [];

        // On court-circuite le gestionnaire natif de GNOME, qui se contente
        // d'afficher une notification « la fenetre est prete ».
        const handler = Main.windowAttentionHandler;
        if (handler) {
            for (const key of ['_windowDemandsAttentionId', '_windowMarkedUrgentId']) {
                const id = handler[key];
                if (id) {
                    global.display.disconnect(id);
                    this._savedHandlerIds.push(key);
                    handler[key] = 0;
                }
            }
        }

        for (const signal of ['window-demands-attention', 'window-marked-urgent']) {
            this._ids.push(global.display.connect(signal, (_display, window) => {
                if (this._shouldFocus(window))
                    Main.activateWindow(window, global.get_current_time());
                else
                    this._notify(window);
            }));
        }
    }

    _shouldFocus(window) {
        if (!window || window.has_focus() || window.is_skip_taskbar())
            return false;

        if (this._settings.get_boolean('skip-notification-windows') &&
            TRANSIENT_TYPES.includes(window.get_window_type()))
            return false;

        const patterns = this._settings.get_strv('blacklist')
            .map(p => p.trim().toLowerCase())
            .filter(p => p.length > 0);
        if (patterns.length === 0)
            return true;

        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const haystack = [
            app?.get_id(),
            app?.get_name(),
            window.get_wm_class(),
            window.get_wm_class_instance(),
            window.get_gtk_application_id(),
            window.get_title(),
        ].filter(s => !!s).join('\n').toLowerCase();

        return !patterns.some(p => haystack.includes(p));
    }

    // Fenetre exclue : on retombe sur le comportement GNOME d'origine
    // (la notification « la fenetre est prete »), plutot que rien du tout.
    _notify(window) {
        const handler = Main.windowAttentionHandler;
        if (handler && typeof handler._onWindowDemandsAttention === 'function')
            handler._onWindowDemandsAttention(global.display, window);
    }

    disable() {
        for (const id of this._ids ?? [])
            global.display.disconnect(id);
        this._ids = [];

        // On rebranche le gestionnaire natif.
        const handler = Main.windowAttentionHandler;
        if (handler && typeof handler._onWindowDemandsAttention === 'function') {
            for (const key of this._savedHandlerIds ?? []) {
                const signal = key === '_windowDemandsAttentionId'
                    ? 'window-demands-attention'
                    : 'window-marked-urgent';
                handler[key] = global.display.connect(signal,
                    (display, win) => handler._onWindowDemandsAttention(display, win));
            }
        }
        this._savedHandlerIds = [];
        this._settings = null;
    }
}
