import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Pas de gettext : l'extension n'a pas de catalogue de traductions.
const CI_REGISTRY = GLib.build_filenamev(
    [GLib.get_user_cache_dir(), 'clipboard-indicator@tudmotu.com', 'registry.txt']);

export default class ClipFlowPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- Raccourci ---
        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Raccourcis',
            description: 'Notation GTK, par exemple <Super>v ou <Control><Alt>v. ' +
                'Laisser vide pour désactiver un raccourci.',
        });
        page.add(shortcutGroup);
        shortcutGroup.add(this._shortcutRow(settings, 'open-history',
            'Ouvrir l\'historique',
            'Ouvre le panneau au curseur de saisie, comme Win+V.'));
        shortcutGroup.add(this._shortcutRow(settings, 'paste-latest',
            'Coller la dernière entrée',
            'Facultatif : recolle directement, sans afficher le panneau.'));

        // --- Barre supérieure ---
        const indicatorGroup = new Adw.PreferencesGroup({title: 'Barre supérieure'});
        page.add(indicatorGroup);

        const indicatorRow = new Adw.SwitchRow({
            title: 'Afficher la dernière copie',
            subtitle: 'Un clic sur l\'aperçu ouvre le même panneau que le raccourci.',
        });
        settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        indicatorGroup.add(indicatorRow);

        indicatorGroup.add(this._spinRow(settings, 'indicator-max-chars',
            'Longueur de l\'aperçu', 'En caractères, au-delà l\'aperçu est coupé.', 10, 120));

        // --- Collage ---
        const pasteGroup = new Adw.PreferencesGroup({title: 'Collage'});
        page.add(pasteGroup);

        const pasteRow = new Adw.SwitchRow({
            title: 'Coller directement',
            subtitle: 'Entrée colle dans la fenêtre d\'origine ; sinon l\'entrée est ' +
                'seulement mise dans le presse-papier. Ctrl+Entrée copie sans coller.',
        });
        settings.bind('paste-on-select', pasteRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        pasteGroup.add(pasteRow);

        // --- Historique ---
        const historyGroup = new Adw.PreferencesGroup({
            title: 'Historique',
            description: '0 = illimité, c\'est le réglage par défaut. Les entrées ' +
                'épinglées ne comptent dans aucune limite et survivent au vidage.',
        });
        page.add(historyGroup);

        historyGroup.add(this._spinRow(settings, 'history-size',
            'Entrées conservées', '0 pour ne jamais rien purger.', 0, 100000));

        const imagesRow = new Adw.SwitchRow({
            title: 'Conserver les images',
            subtitle: 'Aucune taille maximale : contrairement à Windows, une image ' +
                'de plus de 4 Mo est enregistrée. La limite ci-dessous purge les ' +
                'plus anciennes, fichiers compris.',
        });
        settings.bind('cache-images', imagesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(imagesRow);

        historyGroup.add(this._spinRow(settings, 'image-cache-size',
            'Images conservées', '0 pour les garder toutes ; surveille l\'espace disque.',
            0, 10000));

        // --- Exclusions ---
        const excludeGroup = new Adw.PreferencesGroup({
            title: 'Applications ignorées',
            description: 'Une classe de fenêtre par ligne (gestionnaires de mots de ' +
                'passe, par exemple). La comparaison ignore la casse et accepte un ' +
                'fragment : « keepass » suffit pour « org.keepassxc.KeePassXC ».',
        });
        page.add(excludeGroup);
        excludeGroup.add(this._excludedRow(settings));

        // --- Maintenance ---
        const toolsGroup = new Adw.PreferencesGroup({title: 'Maintenance'});
        page.add(toolsGroup);
        toolsGroup.add(this._importRow(settings, window));
    }

    _shortcutRow(settings, key, title, subtitle) {
        const current = settings.get_strv(key);
        const row = new Adw.EntryRow({
            title,
            text: current.length > 0 ? current[0] : '',
            show_apply_button: true,
        });
        if (subtitle)
            row.set_tooltip_text(subtitle);

        row.connect('apply', () => {
            const value = row.text.trim();

            if (value === '') {
                row.remove_css_class('error');
                settings.set_strv(key, []);
                return;
            }

            // Un raccourci invalide passerait silencieusement à la trappe.
            const [ok, keyval] = Gtk.accelerator_parse(value);
            if (!ok || keyval === 0) {
                row.add_css_class('error');
                return;
            }

            row.remove_css_class('error');
            settings.set_strv(key, [value]);
        });

        return row;
    }

    _excludedRow(settings) {
        const row = new Adw.PreferencesRow({activatable: false});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
            spacing: 8,
        });
        row.set_child(box);

        const view = new Gtk.TextView({
            monospace: true,
            top_margin: 6, bottom_margin: 6, left_margin: 6, right_margin: 6,
        });
        view.buffer.text = settings.get_strv('excluded-apps').join('\n');

        const scrolled = new Gtk.ScrolledWindow({
            min_content_height: 110,
            css_classes: ['card'],
            child: view,
        });
        box.append(scrolled);

        const apply = new Gtk.Button({
            label: 'Appliquer',
            halign: Gtk.Align.END,
            css_classes: ['suggested-action'],
        });
        apply.connect('clicked', () => {
            const lines = view.buffer.text.split('\n')
                .map(line => line.trim())
                .filter(line => line !== '');
            settings.set_strv('excluded-apps', lines);
        });
        box.append(apply);

        return row;
    }

    /**
     * L'import est délégué à l'extension via `pending-import` : c'est elle qui
     * détient l'historique en mémoire, une écriture depuis ce processus-ci
     * serait écrasée à sa prochaine sauvegarde.
     */
    _importRow(settings, window) {
        const exists = Gio.File.new_for_path(CI_REGISTRY).query_exists(null);
        const row = new Adw.ActionRow({
            title: 'Importer depuis Clipboard Indicator',
            subtitle: exists
                ? 'Reprend le registre existant, favoris compris (épinglés).'
                : 'Aucun registre trouvé dans le cache de Clipboard Indicator.',
        });

        const button = new Gtk.Button({
            label: 'Importer',
            valign: Gtk.Align.CENTER,
            sensitive: exists,
        });
        button.connect('clicked', () => {
            button.sensitive = false;
            settings.set_string('pending-import', CI_REGISTRY);
            row.subtitle = 'Import demandé — le résultat s\'affiche en notification.';
        });
        row.add_suffix(button);

        return row;
    }

    /**
     * `Adw.SpinRow.value` est un double : `settings.bind` refuse de l'accrocher
     * à une clé entière, d'où la liaison manuelle dans les deux sens.
     */
    _spinRow(settings, key, title, subtitle, lower, upper) {
        const row = new Adw.SpinRow({
            title,
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
