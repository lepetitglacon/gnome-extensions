/**
 * Clip Flow — l'équivalent de Win+V sous GNOME.
 *
 * Super+V ouvre un panneau au curseur, on filtre au clavier, Entrée colle dans
 * la fenêtre d'où l'on vient. Pas d'icône dans la barre supérieure : le
 * raccourci est la seule porte d'entrée, et c'est une chose de moins à casser.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClipboardMonitor} from './clipboardMonitor.js';
import {History} from './history.js';
import {ClipFlowIndicator} from './indicator.js';
import {ClipFlowOverlay} from './overlay.js';
import {VirtualKeyboard, needsShiftPaste} from './keyboard.js';

// Laisse à la fenêtre d'origine le temps de reprendre le focus avant la frappe.
const PASTE_DELAY_MS = 120;
// Puis on attend que Super (ou tout autre modificateur) soit relâché.
const MODIFIER_POLL_MS = 40;
const MODIFIER_MAX_WAIT_MS = 800;

const BLOCKING_MODS =
    Clutter.ModifierType.MOD1_MASK |    // Alt
    Clutter.ModifierType.MOD4_MASK |    // Super
    Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.SHIFT_MASK;

export default class ClipFlowExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._pasteId = 0;

        this._history = new History(this._settings);
        this._history.load();

        this._monitor = new ClipboardMonitor(this._settings, this._history);
        this._monitor.start();

        this._keyboard = new VirtualKeyboard();

        this._overlay = new ClipFlowOverlay({
            settings: this._settings,
            history: this._history,
            onActivate: (entry, options) => this._apply(entry, options),
        });

        this._historyChangedId = this._history.connect('changed', () => {
            this._overlay.onHistoryChanged();
            this._indicator?.update(this._history.entries[0]);
        });

        this._indicatorId = this._settings.connect('changed::show-indicator',
            () => this._syncIndicator());
        this._charsId = this._settings.connect('changed::indicator-max-chars',
            () => this._indicator?.update(this._history.entries[0]));
        this._syncIndicator();

        // Un clic dans la barre supérieure peut faire perdre le focus fenêtre :
        // on garde la dernière fenêtre connue pour savoir où coller.
        this._lastWindow = global.display.focus_window;
        this._focusId = global.display.connect('notify::focus-window', () => {
            const window = global.display.focus_window;
            if (window)
                this._lastWindow = window;
        });

        this._importId = this._settings.connect('changed::pending-import',
            () => this._consumeImport());
        this._consumeImport();

        // Super+V recolle la dernière entrée sans rien afficher ; le panneau
        // s'ouvre au clic sur l'aperçu, ou par un second raccourci si l'on en
        // règle un (vide par défaut).
        Main.wm.addKeybinding(
            'paste-latest',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._pasteLatest());

        Main.wm.addKeybinding(
            'open-history',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._overlay.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('paste-latest');
        Main.wm.removeKeybinding('open-history');

        if (this._importId) {
            this._settings.disconnect(this._importId);
            this._importId = 0;
        }

        if (this._pasteId) {
            GLib.source_remove(this._pasteId);
            this._pasteId = 0;
        }

        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }

        for (const id of [this._indicatorId, this._charsId]) {
            if (id)
                this._settings.disconnect(id);
        }
        this._indicatorId = 0;
        this._charsId = 0;

        this._indicator?.destroy();
        this._indicator = null;
        this._lastWindow = null;

        this._history?.disconnect(this._historyChangedId);
        this._historyChangedId = 0;

        this._overlay?.destroy();
        this._overlay = null;

        this._monitor?.stop();
        this._monitor = null;

        this._keyboard?.destroy();
        this._keyboard = null;

        // Vide l'écriture en attente : `disable()` est aussi appelé à l'extinction.
        this._history?.destroy();
        this._history = null;

        this._settings = null;
    }

    /** L'entrée la plus récente, recollée telle quelle dans la fenêtre active. */
    _pasteLatest() {
        const entry = this._history.entries[0];
        if (!entry) {
            Main.notify('Clip Flow', 'Historique vide.');
            return;
        }

        this._apply(entry, {
            paste: true,
            window: global.display.focus_window ?? this._lastWindow,
        });
    }

    _syncIndicator() {
        const wanted = this._settings.get_boolean('show-indicator');

        if (!wanted) {
            this._indicator?.destroy();
            this._indicator = null;
            return;
        }

        if (this._indicator)
            return;

        this._indicator = new ClipFlowIndicator(this._settings, () => this._overlay.toggle());
        Main.panel.addToStatusArea('clip-flow', this._indicator, 0, 'right');
        this._indicator.update(this._history.entries[0]);
    }

    _consumeImport() {
        const path = this._settings.get_string('pending-import');
        if (path === '')
            return;

        // Vidée d'abord : un import qui échoue ne doit pas se rejouer à chaque
        // activation de l'extension.
        this._settings.set_string('pending-import', '');
        const count = this._history.importRegistry(path);
        Main.notify('Clip Flow', `${count} entrée(s) importée(s).`);
    }

    /** Écrit l'entrée dans le presse-papier, puis éventuellement la colle. */
    _apply(entry, {paste, window}) {
        // Sans cela notre propre écriture repart dans l'historique.
        this._monitor.mute();

        if (entry.type === 'image')
            this._writeImage(entry, paste, window);
        else
            this._writeText(entry, paste, window);

        this._history.touch(entry.id);
    }

    _writeText(entry, paste, window) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, entry.text);
        this._paste(paste, window);
    }

    _writeImage(entry, paste, window) {
        Gio.File.new_for_path(entry.path).load_bytes_async(null, (file, res) => {
            try {
                const [bytes] = file.load_bytes_finish(res);
                St.Clipboard.get_default().set_content(
                    St.ClipboardType.CLIPBOARD, entry.mime ?? 'image/png', bytes);
            } catch (e) {
                logError(e, 'clip-flow: lecture de l\'image');
                return;
            }
            this._paste(paste, window);
        });
    }

    /**
     * Le collage n'est possible que si la fenêtre d'origine a bien repris le
     * focus : la frappe part du seat, elle atterrit là où est le clavier.
     */
    _paste(paste, sourceWindow) {
        if (!paste || !this._settings.get_boolean('paste-on-select'))
            return;

        const window = sourceWindow ?? this._lastWindow;

        if (window && !window.get_compositor_private()?.is_destroyed?.()) {
            try {
                window.activate(global.get_current_time());
            } catch (e) {
                // Fenêtre fermée entre-temps : on colle dans ce qui a le focus.
            }
        }

        if (this._pasteId)
            GLib.source_remove(this._pasteId);

        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteId = 0;
            this._waited = 0;
            this._pasteWhenReady();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Le raccourci est encore tenu au moment où l'on voudrait coller : on
     * attend qu'il retombe, puis on force le relâchement pour les cas où
     * l'état du clavier reste bloqué.
     */
    _pasteWhenReady() {
        const [, , mods] = global.get_pointer();

        if ((mods & BLOCKING_MODS) !== 0 && this._waited < MODIFIER_MAX_WAIT_MS) {
            this._waited += MODIFIER_POLL_MS;
            this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MODIFIER_POLL_MS, () => {
                this._pasteId = 0;
                this._pasteWhenReady();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const target = global.display.focus_window;
        this._keyboard?.releaseModifiers();
        this._keyboard?.paste(needsShiftPaste(target?.get_wm_class()));
    }
}
