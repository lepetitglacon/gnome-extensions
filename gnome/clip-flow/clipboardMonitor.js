/**
 * Capture des copies.
 *
 * Aucun sondage : on écoute `owner-changed` sur la sélection du presse-papier.
 * Le sondage à 500 ms — la méthode habituelle des extensions de ce genre —
 * rate les copies rapides, en duplique d'autres et réveille le shell pour rien
 * plusieurs fois par seconde.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

// Certaines applications posent le presse-papier en deux temps (texte, puis
// formats enrichis) : on laisse retomber la rafale avant de lire.
const COALESCE_MS = 120;
// Fenêtre pendant laquelle nos propres écritures sont ignorées.
const SELF_WRITE_MUTE_MS = 700;

const TEXT_MIMES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING'];
const IMAGE_MIMES = ['image/png', 'image/jpeg'];

export class ClipboardMonitor {
    constructor(settings, history) {
        this._settings = settings;
        this._history = history;
        this._clipboard = St.Clipboard.get_default();
        this._selection = null;
        this._ownerChangedId = 0;
        this._readId = 0;
        this._muteUntil = 0;
    }

    start() {
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed', (selection, type) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
                return;
            this._queueRead();
        });
    }

    stop() {
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        if (this._readId) {
            GLib.source_remove(this._readId);
            this._readId = 0;
        }
        this._selection = null;
    }

    /**
     * À appeler juste avant d'écrire nous-mêmes dans le presse-papier, sinon
     * chaque collage réinjecte son propre contenu dans l'historique et fait
     * remonter l'entrée choisie en boucle.
     */
    mute() {
        this._muteUntil = GLib.get_monotonic_time() / 1000 + SELF_WRITE_MUTE_MS;
    }

    _queueRead() {
        if (this._readId)
            GLib.source_remove(this._readId);

        this._readId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, COALESCE_MS, () => {
            this._readId = 0;
            this._read();
            return GLib.SOURCE_REMOVE;
        });
    }

    _read() {
        if (GLib.get_monotonic_time() / 1000 < this._muteUntil)
            return;

        const source = this._focusedApp();
        if (this._isExcluded(source))
            return;

        const mimes = this._mimetypes();
        const image = this._settings.get_boolean('cache-images')
            ? IMAGE_MIMES.find(mime => mimes.includes(mime))
            : null;

        // Un copier-coller d'image embarque souvent un texte de repli (le nom
        // du fichier) : l'image prime quand elle est disponible.
        if (image) {
            this._clipboard.get_content(St.ClipboardType.CLIPBOARD, image, (clipboard, bytes) => {
                if (bytes && bytes.get_size() > 0)
                    this._history.addImage(bytes, image, source);
                else
                    this._readText(source);
            });
            return;
        }

        this._readText(source);
    }

    _readText(source) {
        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (clipboard, text) => {
            if (text)
                this._history.addText(text, source);
        });
    }

    /**
     * `get_mimetypes` n'est pas garanti sur toutes les versions du shell ; en
     * cas d'échec on suppose du texte, qui est le cas de très loin le plus
     * fréquent.
     */
    _mimetypes() {
        try {
            return this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
        } catch (e) {
            return TEXT_MIMES;
        }
    }

    _focusedApp() {
        const window = global.display.focus_window;
        return window?.get_wm_class() ?? '';
    }

    _isExcluded(source) {
        if (!source)
            return false;

        const excluded = this._settings.get_strv('excluded-apps');
        const needle = source.toLowerCase();
        return excluded.some(name => name.trim() !== '' && needle.includes(name.trim().toLowerCase()));
    }
}
