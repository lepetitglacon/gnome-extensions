import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class FocusNewWindowPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({title: 'Focus', icon_name: 'focus-windows-symbolic'});
        window.add(page);

        const general = new Adw.PreferencesGroup({title: 'Général'});
        page.add(general);

        const skipRow = new Adw.SwitchRow({
            title: 'Ignorer les fenêtres transitoires',
            subtitle: 'Toasts, menus, splash screens : jamais de focus automatique.',
        });
        settings.bind('skip-notification-windows', skipRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        general.add(skipRow);

        const group = new Adw.PreferencesGroup({
            title: 'Applications exclues',
            description: 'Un motif par ligne, insensible à la casse. Il est comparé à ' +
                "l'identifiant d'application, à la classe WM et au titre de la fenêtre. " +
                'Ces fenêtres retombent sur la notification « la fenêtre est prête ».',
        });
        page.add(group);

        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });
        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Ajouter un motif',
            css_classes: ['flat'],
        });
        group.set_header_suffix(add);
        group.add(listBox);

        const rebuild = () => {
            let child;
            while ((child = listBox.get_first_child()))
                listBox.remove(child);

            const patterns = settings.get_strv('blacklist');
            patterns.forEach((pattern, index) => {
                const row = new Adw.EntryRow({title: 'Motif', text: pattern});
                row.connect('changed', () => {
                    const current = settings.get_strv('blacklist');
                    current[index] = row.get_text();
                    settings.set_strv('blacklist', current);
                });

                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    const current = settings.get_strv('blacklist');
                    current.splice(index, 1);
                    settings.set_strv('blacklist', current);
                    rebuild();
                });
                row.add_suffix(remove);
                listBox.append(row);
            });

            if (patterns.length === 0) {
                listBox.append(new Adw.ActionRow({
                    title: 'Aucune exclusion',
                    subtitle: 'Toutes les fenêtres prennent le focus.',
                }));
            }
        };

        add.connect('clicked', () => {
            const current = settings.get_strv('blacklist');
            current.push('');
            settings.set_strv('blacklist', current);
            rebuild();
        });

        rebuild();
    }
}
