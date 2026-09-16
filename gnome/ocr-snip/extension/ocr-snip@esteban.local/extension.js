/**
 * OCR Snip — clic sur l'icône, on trace une zone, le texte part au presse-papier.
 *
 * Le shell ne fait ici que trois choses : la sélection de zone, la capture PNG
 * et un POST vers le démon local (`server/server.js`). Aucun calcul d'OCR n'a
 * lieu dans ce processus : GJS est mono-thread, un modèle ONNX bloquerait
 * l'intégralité du bureau.
 */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';

const DAEMON_UNIT = 'ocr-snip.service';
// Le démon charge ses modèles au démarrage ; on lui laisse le temps.
const DAEMON_BOOT_TIMEOUT_MS = 30000;
const DAEMON_POLL_MS = 400;
// Laisse retomber l'animation de la sélection avant de photographier l'écran.
const SETTLE_MS = 150;
const MIN_AREA_PX = 4;


// --- Petits utilitaires -----------------------------------------------------

function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

/** Lance une commande et attend sa fin sans bloquer la boucle du shell. */
function spawnCheck(argv) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_check_async(null, (self, res) => {
            try {
                self.wait_check_finish(res);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

function ellipsize(text, max) {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** POST JSON non bloquant vers le démon. */
function postJson(session, uri, payload) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new('POST', uri);
        const body = new TextEncoder().encode(JSON.stringify(payload));
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(body));

        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (self, res) => {
            try {
                const bytes = self.send_and_read_finish(res);
                const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
                const parsed = text ? JSON.parse(text) : {};
                if (message.get_status() !== Soup.Status.OK)
                    reject(new Error(parsed.error || `HTTP ${message.get_status()}`));
                else
                    resolve(parsed);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function getJson(session, uri) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new('GET', uri);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (self, res) => {
            try {
                const bytes = self.send_and_read_finish(res);
                const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
                resolve(text ? JSON.parse(text) : {});
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Résout le dossier de destination : réglage de l'utilisateur (« ~ » développé),
 * créé au besoin, avec repli sur le dossier temporaire si quoi que ce soit
 * échoue — une capture ne doit jamais être perdue à cause d'un chemin invalide.
 */
function resolveCaptureDir(configured) {
    const wanted = (configured || '').trim();
    if (!wanted)
        return GLib.get_tmp_dir();

    const expanded = wanted.startsWith('~')
        ? GLib.get_home_dir() + wanted.slice(1)
        : wanted;

    try {
        const dir = Gio.File.new_for_path(expanded);
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
        return expanded;
    } catch (e) {
        logError(e, `ocr-snip: dossier « ${expanded} » inutilisable, repli sur /tmp`);
        return GLib.get_tmp_dir();
    }
}

/** Capture la zone en PNG dans `directory` et renvoie le chemin du fichier. */
function screenshotArea(x, y, width, height, directory) {
    return new Promise((resolve, reject) => {
        const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
        const filePath = GLib.build_filenamev([
            directory, `ocr-snip-${stamp}-${GLib.random_int_range(1000, 10000)}.png`]);
        const file = Gio.File.new_for_path(filePath);

        let stream;
        try {
            stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            reject(e);
            return;
        }

        const shooter = new Shell.Screenshot();
        shooter.set_cursor_enabled?.(false);
        shooter.screenshot_area(x, y, width, height, stream, (obj, res) => {
            try {
                obj.screenshot_area_finish(res);
                stream.close(null);
                resolve(filePath);
            } catch (e) {
                try {
                    stream.close(null);
                } catch (_e) { /* rien à faire */ }
                file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                reject(e);
            }
        });
    });
}

// --- Sélecteur de zone de repli --------------------------------------------

/**
 * Reproduit le comportement de `SelectArea` du shell si l'import a échoué
 * (API privée, susceptible de disparaître d'une version à l'autre).
 */
const FallbackSelectArea = GObject.registerClass(
class FallbackSelectArea extends St.Widget {
    _init() {
        super._init({reactive: true, x: 0, y: 0, style_class: 'ocr-snip-select'});

        this._startX = -1;
        this._startY = -1;
        this._result = null;
        this._resolve = null;

        Main.uiGroup.add_child(this);
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        this._rubberband = new St.Widget({
            style_class: 'ocr-snip-rubberband',
            visible: false,
        });
        this.add_child(this._rubberband);
    }

    selectAsync() {
        return new Promise(resolve => {
            this._resolve = resolve;
            Main.uiGroup.set_child_above_sibling(this, null);
            Main.pushModal(this, {actionMode: Shell.ActionMode.NORMAL});
            global.display.set_cursor(Meta.Cursor.CROSSHAIR);
        });
    }

    _finish(result) {
        if (!this._resolve)
            return;
        const resolve = this._resolve;
        this._resolve = null;
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        Main.popModal(this);
        this.destroy();
        resolve(result);
    }

    _geometry() {
        return {
            x: Math.min(this._startX, this._lastX),
            y: Math.min(this._startY, this._lastY),
            width: Math.abs(this._startX - this._lastX) + 1,
            height: Math.abs(this._startY - this._lastY) + 1,
        };
    }

    vfunc_key_press_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this._finish(null);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_press_event(event) {
        [this._startX, this._startY] = event.get_coords().map(Math.floor);
        [this._lastX, this._lastY] = [this._startX, this._startY];
        this._rubberband.set_position(this._startX, this._startY);
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (this._startX === -1)
            return Clutter.EVENT_PROPAGATE;
        [this._lastX, this._lastY] = event.get_coords().map(Math.floor);
        const geo = this._geometry();
        this._rubberband.set_position(geo.x, geo.y);
        this._rubberband.set_size(geo.width, geo.height);
        this._rubberband.show();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event() {
        if (this._startX === -1)
            return Clutter.EVENT_PROPAGATE;
        this._finish(this._geometry());
        return Clutter.EVENT_STOP;
    }
});

// --- Indicateur -------------------------------------------------------------

const OcrIndicator = GObject.registerClass(
class OcrIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'OCR Snip', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._session = new Soup.Session({timeout: 60});
        this._history = [];
        this._busy = false;

        this._icon = new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        this._snipItem = new PopupMenu.PopupMenuItem(_('Capturer une zone'));
        this._snipItem.connect('activate', () => this.snip());
        this.menu.addMenuItem(this._snipItem);

        this._historySection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Derniers résultats')));
        this.menu.addMenuItem(this._historySection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefsItem = new PopupMenu.PopupMenuItem(_('Paramètres…'));
        prefsItem.connect('activate', () => extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        this._renderHistory();
    }

    /** Clic gauche = capture directe ; clic droit = menu. */
    vfunc_event(event) {
        const type = event.type();
        const isPress = type === Clutter.EventType.BUTTON_PRESS ||
                        type === Clutter.EventType.TOUCH_BEGIN;
        if (isPress && event.get_button?.() === Clutter.BUTTON_PRIMARY) {
            this.snip();
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_event(event);
    }

    _setBusy(busy) {
        this._busy = busy;
        this._icon.icon_name = busy ? 'content-loading-symbolic' : 'edit-find-symbolic';
        this._icon.opacity = busy ? 140 : 255;
        this._snipItem.sensitive = !busy;
    }

    _uri(path) {
        return `http://127.0.0.1:${this._settings.get_int('port')}${path}`;
    }

    _renderHistory() {
        this._historySection.removeAll();
        if (this._history.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('(aucun)'));
            empty.sensitive = false;
            this._historySection.addMenuItem(empty);
            return;
        }
        for (const entry of this._history) {
            const item = new PopupMenu.PopupMenuItem(ellipsize(entry, 44));
            item.connect('activate', () => this._copy(entry, false));
            this._historySection.addMenuItem(item);
        }
    }

    _pushHistory(text) {
        const max = this._settings.get_int('history-size');
        if (max <= 0) {
            this._history = [];
        } else {
            this._history = [text, ...this._history.filter(t => t !== text)].slice(0, max);
        }
        this._renderHistory();
    }

    _copy(text, silent = true) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        if (!silent)
            Main.notify('OCR Snip', _('Recopié dans le presse-papier.'));
    }

    // --- Démon ---------------------------------------------------------------

    async _ensureDaemon() {
        try {
            await getJson(this._session, this._uri('/health'));
            return;
        } catch (_e) {
            // Pas de réponse : on tente de le démarrer.
        }

        await this._startDaemon();

        const deadline = GLib.get_monotonic_time() + DAEMON_BOOT_TIMEOUT_MS * 1000;
        let lastError = null;
        while (GLib.get_monotonic_time() < deadline) {
            await sleep(DAEMON_POLL_MS);
            try {
                await getJson(this._session, this._uri('/health'));
                return;
            } catch (e) {
                lastError = e;
            }
        }
        throw new Error(`démon injoignable (${lastError?.message ?? 'délai dépassé'})`);
    }

    /**
     * Unité systemd si elle est installée, sinon lancement direct de node —
     * l'extension reste utilisable sans avoir passé par install.sh.
     * Tout est asynchrone : le shell ne doit jamais attendre un sous-processus.
     */
    async _startDaemon() {
        try {
            await spawnCheck(['systemctl', '--user', 'start', DAEMON_UNIT]);
            return;
        } catch (e) {
            log(`ocr-snip: systemd indisponible (${e.message}), lancement direct`);
        }

        const serverPath = GLib.build_filenamev([
            GLib.get_home_dir(), 'PhpstormProjects', 'ocr-snip', 'server', 'server.js']);
        try {
            Gio.Subprocess.new(
                ['node', serverPath],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, 'ocr-snip: impossible de lancer le démon');
        }
    }

    // --- Capture -------------------------------------------------------------

    async snip() {
        if (this._busy)
            return;
        this.menu.close();

        let area;
        try {
            // `SelectArea` est privé au shell : s'il disparaît d'une version
            // à l'autre, on retombe sur le sélecteur maison.
            const Selector = Screenshot.SelectArea ?? FallbackSelectArea;
            const selector = new Selector();
            area = await selector.selectAsync();
        } catch (e) {
            logError(e, 'ocr-snip: sélection impossible');
            return;
        }

        if (!area || area.width < MIN_AREA_PX || area.height < MIN_AREA_PX)
            return; // Échap, ou simple clic : on annule sans bruit.

        this._setBusy(true);
        try {
            await sleep(SETTLE_MS);
            const captureDir = resolveCaptureDir(this._settings.get_string('capture-dir'));
            const filePath = await screenshotArea(
                area.x, area.y, area.width, area.height, captureDir);

            await this._ensureDaemon();
            const result = await postJson(this._session, this._uri('/ocr'), {
                path: filePath,
                lang: this._settings.get_string('lang'),
                keepFile: this._settings.get_boolean('keep-captures'),
            });

            const text = (result.text || '').trim();
            if (!text) {
                Main.notify('OCR Snip', _('Aucun texte reconnu dans cette zone.'));
                return;
            }

            if (this._settings.get_boolean('copy-to-clipboard'))
                this._copy(text);
            this._pushHistory(text);

            if (this._settings.get_boolean('show-notification')) {
                Main.notify(
                    `OCR Snip — ${result.lines.length} ligne(s), ${result.ms} ms`,
                    ellipsize(text, 200));
            }
        } catch (e) {
            logError(e, 'ocr-snip');
            Main.notifyError('OCR Snip', e.message);
        } finally {
            this._setBusy(false);
        }
    }

    destroy() {
        this._session?.abort();
        this._session = null;
        super.destroy();
    }
});

// --- Extension --------------------------------------------------------------

export default class OcrSnipExtension extends Extension {
    enable() {
        this._indicator = new OcrIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
