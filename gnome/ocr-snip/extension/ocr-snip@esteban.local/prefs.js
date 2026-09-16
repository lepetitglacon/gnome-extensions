import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Pas de gettext ici : l'extension n'a pas de catalogue de traductions, et
// `_()` au niveau module lève « gettext can only be called from extensions ».
const LANGS = [
    ['fr', 'Français / anglais — PP-OCRv5 (recommandé)'],
    ['latin', 'Latin — PP-OCRv3 (repli)'],
    ['ch', 'Chinois + anglais — PP-OCRv4'],
];

export default class OcrSnipPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- Reconnaissance ---
        const ocrGroup = new Adw.PreferencesGroup({
            title: 'Reconnaissance',
            description: 'Les trois jeux de modèles sont installés localement ; ' +
                'le changement prend effet à la capture suivante.',
        });
        page.add(ocrGroup);

        const codes = LANGS.map(([code]) => code);
        const langRow = new Adw.ComboRow({
            title: 'Langue',
            model: Gtk.StringList.new(LANGS.map(([, label]) => label)),
            selected: Math.max(0, codes.indexOf(settings.get_string('lang'))),
        });
        langRow.connect('notify::selected',
            row => settings.set_string('lang', codes[row.selected]));
        ocrGroup.add(langRow);

        // --- Résultat ---
        const outGroup = new Adw.PreferencesGroup({title: 'Résultat'});
        page.add(outGroup);

        const clipboardRow = new Adw.SwitchRow({title: 'Copier dans le presse-papier'});
        settings.bind('copy-to-clipboard', clipboardRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        outGroup.add(clipboardRow);

        const notifyRow = new Adw.SwitchRow({
            title: 'Afficher une notification',
            subtitle: 'Aperçu du texte reconnu et durée du traitement.',
        });
        settings.bind('show-notification', notifyRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        outGroup.add(notifyRow);

        outGroup.add(this._spinRow(settings, 'history-size',
            'Résultats gardés dans le menu', null, 0, 20));

        // --- Démon ---
        const daemonGroup = new Adw.PreferencesGroup({
            title: 'Démon OCR',
            description: 'Processus Node local, démarré à la demande et arrêté ' +
                'après 15 min d\'inactivité.',
        });
        page.add(daemonGroup);

        daemonGroup.add(this._spinRow(settings, 'port',
            'Port', 'Sur 127.0.0.1 uniquement.', 1024, 65535));

        // --- Captures ---
        const captureGroup = new Adw.PreferencesGroup({
            title: 'Captures',
            description: 'Laisser le dossier vide pour écrire dans le dossier ' +
                'temporaire du système. Le dossier indiqué est créé s\'il manque.',
        });
        page.add(captureGroup);

        captureGroup.add(this._captureDirRow(settings, window));

        const keepRow = new Adw.SwitchRow({
            title: 'Conserver les captures',
            subtitle: 'Sans quoi le PNG est supprimé dès que le texte en a été extrait.',
        });
        settings.bind('keep-captures', keepRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        captureGroup.add(keepRow);
    }

    /** Champ libre + sélecteur de dossier ; vide = dossier temporaire système. */
    _captureDirRow(settings, window) {
        const row = new Adw.EntryRow({
            title: 'Dossier des captures',
            text: settings.get_string('capture-dir'),
            show_apply_button: true,
        });
        row.connect('apply', () => settings.set_string('capture-dir', row.text.trim()));
        settings.connect('changed::capture-dir', () => {
            const value = settings.get_string('capture-dir');
            if (row.text !== value)
                row.text = value;
        });

        const browse = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: 'Parcourir…',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        browse.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Dossier des captures'});
            const current = settings.get_string('capture-dir').trim();
            if (current)
                dialog.set_initial_folder(Gio.File.new_for_path(current));
            dialog.select_folder(window, null, (self, res) => {
                try {
                    const folder = self.select_folder_finish(res);
                    if (folder)
                        settings.set_string('capture-dir', folder.get_path());
                } catch (e) {
                    // Annulation de l'utilisateur : rien à signaler.
                }
            });
        });
        row.add_suffix(browse);

        const reset = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Revenir au dossier temporaire système',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => settings.set_string('capture-dir', ''));
        row.add_suffix(reset);

        return row;
    }

    /**
     * `Adw.SpinRow.value` est un double : `settings.bind` refuse de l'accrocher
     * à une clé entière, d'où la liaison manuelle dans les deux sens.
     */
    _spinRow(settings, key, title, subtitle, lower, upper) {
        const row = new Adw.SpinRow({
            title,
            // `undefined` n'est pas accepté dans un initialiseur GObject.
            ...(subtitle ? {subtitle} : {}),
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1}),
            value: settings.get_int(key),
        });
        row.connect('notify::value', () => {
            const value = Math.round(row.value);
            if (settings.get_int(key) !== value)
                settings.set_int(key, value);
        });
        settings.connect(`changed::${key}`, () => {
            row.value = settings.get_int(key);
        });
        return row;
    }
}
