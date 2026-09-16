/**
 * Historique persistant.
 *
 * Le fichier n'est jamais réécrit à chaque copie : les écritures sont
 * regroupées (`SAVE_DEBOUNCE_MS`) et atomiques, sans quoi une rafale de copies
 * suffit à laisser un JSON tronqué derrière elle — panne classique des
 * gestionnaires de presse-papier.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const SAVE_DEBOUNCE_MS = 2000;
// Rien n'interdit de copier plusieurs mégaoctets : on n'indexe pour la
// recherche que le début de chaque entrée, une seule fois.
const SEARCH_INDEX_CHARS = 65536;

export const History = GObject.registerClass({
    Signals: {'changed': {}},
}, class History extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._entries = [];
        this._searchKeys = new Map();
        this._saveId = 0;
        this._dirty = false;

        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'clip-flow']));
        this._imageDir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'clip-flow', 'images']));
        this._file = this._dir.get_child('history.json');
    }

    get entries() {
        return this._entries;
    }

    /**
     * Filtre sur le contenu. `needle` est déjà en minuscules ; la chaîne vide
     * renvoie tout l'historique, sans copie.
     */
    search(needle) {
        if (needle === '')
            return this._entries;

        const results = [];
        for (const entry of this._entries) {
            const haystack = entry.type === 'image' ? 'image' : this._searchKey(entry);
            if (haystack.includes(needle))
                results.push(entry);
        }
        return results;
    }

    _searchKey(entry) {
        let key = this._searchKeys.get(entry.id);
        if (key === undefined) {
            key = entry.text.slice(0, SEARCH_INDEX_CHARS).toLowerCase();
            this._searchKeys.set(entry.id, key);
        }
        return key;
    }

    // --- Chargement / sauvegarde --------------------------------------------

    /** Lecture asynchrone : `enable()` tourne pendant l'ouverture de session. */
    load() {
        this._file.load_contents_async(null, (file, res) => {
            let parsed = [];
            try {
                const [ok, bytes] = file.load_contents_finish(res);
                if (ok)
                    parsed = JSON.parse(new TextDecoder().decode(bytes));
            } catch (e) {
                // Premier lancement, ou fichier illisible : historique vide.
            }

            if (Array.isArray(parsed))
                this._entries = parsed.filter(entry => this._isUsable(entry));

            this.emit('changed');
        });
    }

    /** Une entrée image dont le PNG a disparu ne doit pas rester affichée. */
    _isUsable(entry) {
        if (!entry || typeof entry !== 'object' || !entry.id)
            return false;
        if (entry.type === 'image')
            return !!entry.path && Gio.File.new_for_path(entry.path).query_exists(null);
        return entry.type === 'text' && typeof entry.text === 'string' && entry.text !== '';
    }

    _scheduleSave() {
        this._dirty = true;
        if (this._saveId)
            return;

        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, SAVE_DEBOUNCE_MS, () => {
            this._saveId = 0;
            this._save(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _save(sync) {
        if (!this._dirty)
            return;
        this._dirty = false;

        this._ensureDir(this._dir);
        const json = JSON.stringify(this._entries);
        const bytes = new GLib.Bytes(new TextEncoder().encode(json));
        const flags = Gio.FileCreateFlags.REPLACE_DESTINATION;

        try {
            if (sync) {
                // Au `disable()` on n'a plus de boucle d'événement devant soi.
                this._file.replace_contents(
                    bytes.get_data(), null, false, flags, null);
            } else {
                this._file.replace_contents_bytes_async(
                    bytes, null, false, flags, null,
                    (file, res) => {
                        try {
                            file.replace_contents_finish(res);
                        } catch (e) {
                            logError(e, 'clip-flow: écriture de l\'historique');
                        }
                    });
            }
        } catch (e) {
            logError(e, 'clip-flow: écriture de l\'historique');
        }
    }

    _ensureDir(dir) {
        try {
            dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                logError(e, 'clip-flow: création du dossier');
        }
    }

    _newId() {
        return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
    }

    // --- Ajout ---------------------------------------------------------------

    addText(text, source) {
        if (!text || text.trim() === '')
            return;

        const index = this._entries.findIndex(
            entry => entry.type === 'text' && entry.text === text);

        if (index === 0) {
            // Déjà en tête : rien à remonter, on évite un rendu inutile.
            this._entries[0].date = Date.now();
            this._scheduleSave();
            return;
        }

        if (index > 0) {
            const [entry] = this._entries.splice(index, 1);
            entry.date = Date.now();
            this._entries.unshift(entry);
        } else {
            this._entries.unshift({
                id: this._newId(),
                type: 'text',
                text,
                source: source ?? '',
                pinned: false,
                date: Date.now(),
            });
        }

        this._prune();
        this._scheduleSave();
        this.emit('changed');
    }

    addImage(bytes, mime, source) {
        const checksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        const index = this._entries.findIndex(
            entry => entry.type === 'image' && entry.checksum === checksum);

        if (index >= 0) {
            if (index > 0) {
                const [entry] = this._entries.splice(index, 1);
                entry.date = Date.now();
                this._entries.unshift(entry);
                this._scheduleSave();
                this.emit('changed');
            }
            return;
        }

        this._ensureDir(this._imageDir);
        const id = this._newId();
        const file = this._imageDir.get_child(`${id}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`);

        file.replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (target, res) => {
                try {
                    target.replace_contents_finish(res);
                } catch (e) {
                    logError(e, 'clip-flow: écriture de l\'image');
                    return;
                }

                this._entries.unshift({
                    id,
                    type: 'image',
                    path: target.get_path(),
                    mime,
                    checksum,
                    size: bytes.get_size(),
                    source: source ?? '',
                    pinned: false,
                    date: Date.now(),
                });

                this._prune();
                this._scheduleSave();
                this.emit('changed');
            });
    }

    // --- Modification --------------------------------------------------------

    remove(id) {
        const index = this._entries.findIndex(entry => entry.id === id);
        if (index < 0)
            return;

        this._dropFile(this._entries[index]);
        this._searchKeys.delete(id);
        this._entries.splice(index, 1);
        this._scheduleSave();
        this.emit('changed');
    }

    togglePin(id) {
        const entry = this._entries.find(item => item.id === id);
        if (!entry)
            return;

        entry.pinned = !entry.pinned;
        // Un dépinglage peut faire repasser l'entrée au-dessus de la limite.
        this._prune();
        this._scheduleSave();
        this.emit('changed');
    }

    /** Vide tout sauf les entrées épinglées, comme le fait Win+V. */
    clear() {
        const kept = [];
        for (const entry of this._entries) {
            if (entry.pinned) {
                kept.push(entry);
            } else {
                this._dropFile(entry);
                this._searchKeys.delete(entry.id);
            }
        }

        this._entries = kept;
        this._scheduleSave();
        this.emit('changed');
    }

    _dropFile(entry) {
        if (entry?.type !== 'image' || !entry.path)
            return;
        try {
            Gio.File.new_for_path(entry.path).delete(null);
        } catch (e) {
            // Fichier déjà absent : rien à signaler.
        }
    }

    /**
     * Les épinglées ne comptent pas dans les quotas : c'est ce qui permet de
     * garder un mot de passe de test ou un tableau de bord sous la main sans
     * qu'une rafale de copies ne l'évacue.
     */
    _prune() {
        // 0 = illimité, des deux côtés : c'est le réglage par défaut.
        const maxEntries = this._settings.get_int('history-size');
        const maxImages = this._settings.get_int('image-cache-size');
        if (maxEntries === 0 && maxImages === 0)
            return;

        let entries = 0;
        let images = 0;
        const kept = [];

        for (const entry of this._entries) {
            if (entry.pinned) {
                kept.push(entry);
                continue;
            }

            const isImage = entry.type === 'image';
            const tooMany = maxEntries > 0 && entries >= maxEntries;
            const tooManyImages = isImage && maxImages > 0 && images >= maxImages;
            if (tooMany || tooManyImages) {
                this._dropFile(entry);
                this._searchKeys.delete(entry.id);
                continue;
            }

            entries++;
            if (isImage)
                images++;
            kept.push(entry);
        }

        this._entries = kept;
    }

    /**
     * Reprise de l'historique de Clipboard Indicator (`registry.txt`).
     *
     * L'import tourne dans le processus du shell et non dans les préférences :
     * l'historique y est déjà chargé en mémoire, une écriture concurrente
     * depuis l'autre processus serait écrasée à la sauvegarde suivante.
     */
    importRegistry(path) {
        let items;
        try {
            const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
            if (!ok)
                return 0;
            items = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            logError(e, 'clip-flow: import de l\'historique');
            return 0;
        }

        if (!Array.isArray(items))
            return 0;

        this._ensureDir(this._imageDir);
        const keepImages = this._settings.get_boolean('cache-images');
        let imported = 0;

        // Le registre va du plus ancien au plus récent : en empilant dans cet
        // ordre, la dernière copie se retrouve bien en tête.
        for (const item of items) {
            if (typeof item?.contents !== 'string' || item.contents === '')
                continue;

            const mime = item.mimetype ?? 'text/plain';
            const pinned = !!item.favorite;

            if (mime.startsWith('image/')) {
                if (!keepImages || !this._importImage(item.contents, mime, pinned))
                    continue;
            } else {
                if (this._entries.some(entry => entry.type === 'text' && entry.text === item.contents))
                    continue;
                this._entries.unshift({
                    id: this._newId(),
                    type: 'text',
                    text: item.contents,
                    source: '',
                    pinned,
                    date: Date.now(),
                });
            }
            imported++;
        }

        this._prune();
        this._dirty = true;
        this._save(true);
        this.emit('changed');
        return imported;
    }

    _importImage(path, mime, pinned) {
        const source = Gio.File.new_for_path(path);
        if (!source.query_exists(null))
            return false;

        try {
            const [ok, data] = source.load_contents(null);
            if (!ok)
                return false;

            const bytes = new GLib.Bytes(data);
            const checksum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
            if (this._entries.some(entry => entry.checksum === checksum))
                return false;

            const id = this._newId();
            const target = this._imageDir.get_child(`${id}.${mime === 'image/jpeg' ? 'jpg' : 'png'}`);
            target.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            this._entries.unshift({
                id,
                type: 'image',
                path: target.get_path(),
                mime,
                checksum,
                size: bytes.get_size(),
                source: '',
                pinned,
                date: Date.now(),
            });
            return true;
        } catch (e) {
            logError(e, 'clip-flow: import d\'une image');
            return false;
        }
    }

    /** Remonte une entrée en tête après un collage, comme le fait Win+V. */
    touch(id) {
        const index = this._entries.findIndex(entry => entry.id === id);
        if (index <= 0)
            return;

        const [entry] = this._entries.splice(index, 1);
        entry.date = Date.now();
        this._entries.unshift(entry);
        this._scheduleSave();
        this.emit('changed');
    }

    destroy() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        this._save(true);
    }
});
