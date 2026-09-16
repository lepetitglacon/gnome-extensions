/**
 * Le panneau, calqué sur celui de Windows.
 *
 * C'est un overlay modal et non un menu de panneau : un menu appartient à une
 * icône de la barre supérieure, se ferme dès que la barre change d'état, et ne
 * peut pas s'afficher au curseur de saisie.
 *
 * Il s'ouvre au pointeur de la souris, dans l'écran où celui-ci se trouve.
 *
 * Deux ajouts assumés par rapport à Windows, demandés : le champ de recherche
 * et la ligne d'informations sous chaque aperçu. Le reste suit le modèle —
 * largeur, trois lignes d'aperçu, actions au survol, « Effacer tout ».
 */
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {previewLines, sizeLabel} from './preview.js';

const PANEL_WIDTH = 340;
const SCREEN_MARGIN = 12;
const PREVIEW_LINES = 3;
const OPEN_DURATION = 140;
const CLOSE_DURATION = 100;

/**
 * L'historique est illimité ; la liste, non. Construire quelques milliers de
 * lignes à chaque ouverture se verrait à l'œil nu, et personne ne défile
 * jusque-là : au-delà, c'est la recherche qui sert.
 */
const RENDER_LIMIT = 60;

export class ClipFlowOverlay {
    constructor({settings, history, onActivate}) {
        this._settings = settings;
        this._history = history;
        this._onActivate = onActivate;

        this._grab = null;
        this._container = null;
        this._rows = [];
        this._selected = -1;
        this._sourceWindow = null;
    }

    get isOpen() {
        return this._grab !== null;
    }

    // --- Ouverture / fermeture ----------------------------------------------

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.isOpen)
            return;

        // Mémorisé avant la prise du modal : ensuite le focus appartient au shell.
        this._sourceWindow = global.display.focus_window;

        this._build();
        Main.layoutManager.modalDialogGroup.add_child(this._container);
        this._position();

        this._grab = Main.pushModal(this._container, {
            actionMode: Shell.ActionMode.POPUP,
        });

        if ((this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            // Une autre fenêtre tient déjà le clavier (menu ouvert, dialogue
            // système) : on renonce proprement plutôt que d'afficher un
            // panneau qui n'écoute rien.
            Main.popModal(this._grab);
            this._grab = null;
            this._destroyContainer();
            log('clip-flow: clavier déjà pris par une autre fenêtre, ouverture annulée');
            return;
        }

        this._entry.grab_key_focus();
        this._refresh();

        this._panel.set_pivot_point(0.5, 0);
        this._panel.opacity = 0;
        this._panel.scale_x = 0.95;
        this._panel.scale_y = 0.95;
        this._panel.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: OPEN_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (!this.isOpen)
            return;

        const grab = this._grab;
        this._grab = null;
        Main.popModal(grab);

        const container = this._container;
        this._container = null;
        this._rows = [];

        this._panel.ease({
            opacity: 0,
            scale_x: 0.97,
            scale_y: 0.97,
            duration: CLOSE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => container.destroy(),
        });
    }

    _destroyContainer() {
        this._container?.destroy();
        this._container = null;
        this._rows = [];
    }

    // --- Construction --------------------------------------------------------

    _build() {
        this._container = new St.Widget({
            name: 'clip-flow-container',
            reactive: true,
            width: global.stage.width,
            height: global.stage.height,
        });

        // Clic à côté du panneau : on ferme, comme n'importe quel menu.
        //
        // On passe par `captured-event` et par les coordonnées plutôt que par
        // la source de l'événement : sous un grab modal la source n'est pas
        // fiable (elle peut être un acteur du shell sous le pointeur), et le
        // clic extérieur restait alors sans effet.
        this._container.connect('captured-event', (actor, event) => {
            const type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS &&
                type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            if (this._panelContains(x, y))
                return Clutter.EVENT_PROPAGATE;

            this.close();
            return Clutter.EVENT_STOP;
        });

        this._panel = new St.BoxLayout({
            style_class: 'popup-menu-content clip-flow-panel',
            vertical: true,
            width: PANEL_WIDTH,
        });
        this._container.add_child(this._panel);

        this._panel.add_child(this._buildHeader());

        this._entry = new St.Entry({
            style_class: 'clip-flow-search',
            hint_text: 'Rechercher…',
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('text-changed', () => this._refresh());
        this._entry.clutter_text.connect('key-press-event', (actor, event) => this._onKeyPress(event));
        this._panel.add_child(this._entry);

        this._scroll = new St.ScrollView({
            style_class: 'clip-flow-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._list = new St.BoxLayout({
            style_class: 'clip-flow-list',
            vertical: true,
            x_expand: true,
        });
        // `set_child` n'existe que depuis GNOME 46.
        if (this._scroll.set_child)
            this._scroll.set_child(this._list);
        else
            this._scroll.add_actor(this._list);
        this._panel.add_child(this._scroll);
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'clip-flow-header', x_expand: true});

        header.add_child(new St.Label({
            style_class: 'clip-flow-title',
            text: 'Presse-papiers',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));

        const clear = new St.Button({
            style_class: 'clip-flow-clear',
            label: 'Effacer tout',
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Comme sous Windows, les entrées épinglées survivent au vidage.
        clear.connect('clicked', () => this._history.clear());
        header.add_child(clear);

        return header;
    }

    /**
     * Ancré au pointeur, et maintenu dans la zone de travail de l'écran qui le
     * contient : c'est `getWorkAreaForMonitor` qui garantit qu'on ne déborde ni
     * sur un autre écran ni sous les barres.
     */
    _position() {
        const [pointerX, pointerY] = global.get_pointer();
        const area = this._workAreaAt(pointerX, pointerY);
        const [, height] = this._panel.get_preferred_height(PANEL_WIDTH);

        const x = Math.max(area.x + SCREEN_MARGIN,
            Math.min(pointerX, area.x + area.width - PANEL_WIDTH - SCREEN_MARGIN));
        const y = Math.max(area.y + SCREEN_MARGIN,
            Math.min(pointerY, area.y + area.height - height - SCREEN_MARGIN));

        this._panel.set_position(Math.round(x), Math.round(y));
    }

    _workAreaAt(x, y) {
        const monitors = Main.layoutManager.monitors;
        let index = monitors.findIndex(monitor =>
            x >= monitor.x && x < monitor.x + monitor.width &&
            y >= monitor.y && y < monitor.y + monitor.height);
        if (index < 0)
            index = Main.layoutManager.primaryIndex;

        return Main.layoutManager.getWorkAreaForMonitor(index);
    }

    /**
     * Le conteneur occupe la scène depuis (0, 0) : la position du panneau est
     * donc déjà en coordonnées écran.
     *
     * La taille est prise sur l'allocation, avec repli sur la taille préférée :
     * juste après l'ouverture, aucune passe de layout n'a encore eu lieu et
     * l'allocation vaut 0×0 — le premier clic fermerait alors le panneau où
     * qu'il tombe.
     */
    _panelContains(x, y) {
        const box = this._panel.get_allocation_box();
        let width = box.x2 - box.x1;
        let height = box.y2 - box.y1;

        if (width <= 0 || height <= 0) {
            width = PANEL_WIDTH;
            [, height] = this._panel.get_preferred_height(PANEL_WIDTH);
        }

        return x >= this._panel.x && x <= this._panel.x + width &&
               y >= this._panel.y && y <= this._panel.y + height;
    }

    // --- Liste ---------------------------------------------------------------

    _refresh() {
        if (!this._container)
            return;

        const needle = this._entry.get_text().trim().toLowerCase();
        const matches = this._history.search(needle);

        this._list.destroy_all_children();
        this._rows = [];

        if (matches.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'clip-flow-empty',
                text: needle === '' ? 'Presse-papier vide' : 'Aucun résultat',
            }));
            this._selected = -1;
            return;
        }

        for (const entry of matches.slice(0, RENDER_LIMIT)) {
            const item = this._buildRow(entry);
            this._rows.push(item);
            this._list.add_child(item.row);
        }

        if (matches.length > RENDER_LIMIT) {
            this._list.add_child(new St.Label({
                style_class: 'clip-flow-more',
                text: `${matches.length - RENDER_LIMIT} autres entrées — affinez la recherche`,
            }));
        }

        this._selected = -1;
        this._select(0);
    }

    _buildRow(entry) {
        const row = new St.Button({
            style_class: 'clip-flow-row',
            x_expand: true,
            can_focus: false,
        });

        const box = new St.BoxLayout({style_class: 'clip-flow-row-box', x_expand: true});
        row.set_child(box);
        box.add_child(this._buildThumbnail(entry));

        const texts = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(texts);

        // Une étiquette par ligne : c'est le seul moyen d'avoir des points de
        // suspension fiables, St ne tronquant pas un paragraphe replié.
        for (const line of previewLines(entry, PREVIEW_LINES)) {
            const label = new St.Label({style_class: 'clip-flow-row-label', text: line});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(label);
        }

        texts.add_child(new St.Label({
            style_class: 'clip-flow-row-meta',
            text: this._meta(entry),
        }));

        const actions = this._buildActions(entry);
        box.add_child(actions);

        const item = {row, entry, actions};

        row.connect('clicked', () => this._activate(entry, true));
        row.connect('notify::hover', () => {
            if (row.hover)
                this._select(this._rows.indexOf(item), false);
            this._syncActions(item);
        });

        // État de départ : sans cet appel les actions naissent visibles sur
        // toutes les lignes, et non sur la seule ligne active.
        this._syncActions(item);

        return item;
    }

    /** Épingler et supprimer, révélés au survol comme dans le panneau Windows. */
    _buildActions(entry) {
        const actions = new St.BoxLayout({
            style_class: 'clip-flow-actions',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const pin = new St.Button({
            style_class: entry.pinned ? 'clip-flow-action clip-flow-action-on' : 'clip-flow-action',
            child: new St.Icon({icon_name: 'view-pin-symbolic', icon_size: 14}),
        });
        pin.connect('clicked', () => this._history.togglePin(entry.id));
        actions.add_child(pin);

        const remove = new St.Button({
            style_class: 'clip-flow-action',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
        });
        remove.connect('clicked', () => this._history.remove(entry.id));
        actions.add_child(remove);

        return actions;
    }

    /** Une entrée épinglée garde son icône visible : c'est son seul marqueur. */
    _syncActions(item) {
        const active = item.row.hover || this._rows[this._selected] === item;
        item.actions.visible = active || item.entry.pinned;
        item.actions.opacity = active ? 255 : 140;
    }

    _buildThumbnail(entry) {
        if (entry.type === 'image') {
            return new St.Icon({
                style_class: 'clip-flow-thumb',
                gicon: Gio.FileIcon.new(Gio.File.new_for_path(entry.path)),
                icon_size: 48,
                y_align: Clutter.ActorAlign.CENTER,
            });
        }

        const text = entry.text.trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) {
            const swatch = new St.Widget({
                style_class: 'clip-flow-swatch',
                y_align: Clutter.ActorAlign.CENTER,
            });
            swatch.set_style(`background-color: ${text};`);
            return swatch;
        }

        const url = /^(https?|ftp|file|ssh|mailto):/i.test(text) && !text.includes('\n');
        return new St.Icon({
            style_class: 'clip-flow-thumb-icon',
            icon_name: url ? 'web-browser-symbolic' : 'text-x-generic-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    /** Heure de la copie et taille, rien de plus. */
    _meta(entry) {
        const time = GLib.DateTime.new_from_unix_local(
            Math.round((entry.date ?? Date.now()) / 1000)).format('%H:%M');

        const size = entry.type === 'image'
            ? sizeLabel(entry)
            : `${entry.text.length} car.`;

        return `${time} · ${size}`;
    }

    // --- Sélection -----------------------------------------------------------

    /**
     * `scroll` n'est vrai qu'au clavier : suivre le pointeur ferait sauter la
     * liste sous la molette, et Windows ne défile pas au survol non plus.
     */
    _select(index, scroll = true) {
        if (this._rows.length === 0)
            return;

        const clamped = Math.max(0, Math.min(index, this._rows.length - 1));
        if (this._selected === clamped)
            return;

        const item = this._rows[clamped];

        // Géométrie relevée AVANT toute retouche de style : `add_style_class_name`
        // invalide l'allocation de la ligne, et `row.y` retombe alors à 0 — la
        // liste se croyait tout en haut et y remontait à chaque sélection.
        const box = scroll ? item.row.get_allocation_box() : null;

        // L'index doit changer avant les synchronisations : `_syncActions` se
        // fie à `this._selected` pour savoir quelle ligne est active.
        const previous = this._rows[this._selected];
        this._selected = clamped;

        if (previous) {
            previous.row.remove_style_class_name('clip-flow-row-selected');
            this._syncActions(previous);
        }

        item.row.add_style_class_name('clip-flow-row-selected');
        this._syncActions(item);

        if (box)
            this._scrollToBox(box);
    }

    _scrollToBox(box) {
        const adjustment = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
        if (!adjustment || adjustment.page_size <= 0)
            return;

        const top = box.y1;
        const bottom = box.y2;
        // Ligne pas encore allouée (liste tout juste reconstruite) : rien à faire.
        if (bottom - top <= 0)
            return;

        if (top < adjustment.value)
            adjustment.value = top;
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = bottom - adjustment.page_size;
    }

    _activate(entry, paste) {
        this.close();
        this._onActivate(entry, {paste, window: this._sourceWindow});
    }

    // --- Clavier -------------------------------------------------------------

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const current = this._rows[this._selected]?.entry;

        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Page_Up:
            this._select(this._selected - 5);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Page_Down:
            this._select(this._selected + 5);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            if (current)
                this._activate(current, !ctrl);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
            // Sans Maj, Suppr appartient au champ de recherche.
            if (shift && current) {
                this._history.remove(current.id);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;

        case Clutter.KEY_p:
        case Clutter.KEY_P:
            if (ctrl && current) {
                this._history.togglePin(current.id);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    /** L'historique a changé pendant que le panneau est ouvert. */
    onHistoryChanged() {
        if (!this.isOpen)
            return;

        const previous = this._selected;
        this._refresh();
        this._select(previous);
    }

    destroy() {
        if (this.isOpen)
            this.close();
        this._destroyContainer();
    }
}
