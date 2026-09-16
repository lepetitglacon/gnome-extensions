/**
 * Le raccourci reste la voie principale ; cette icône sert à *voir* ce qu'on a
 * copié sans rien ouvrir, et à atteindre l'historique à la souris.
 *
 * Volontairement sans menu : le clic rouvre le même panneau que Super+V, pour
 * n'avoir qu'un seul comportement à maintenir.
 */
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {previewFor} from './preview.js';

export const ClipFlowIndicator = GObject.registerClass(
class ClipFlowIndicator extends PanelMenu.Button {
    _init(settings, onClick) {
        // Troisième argument : pas de menu créé, on gère le clic nous-mêmes.
        super._init(0.0, 'Clip Flow', true);

        this._settings = settings;

        const box = new St.BoxLayout({style_class: 'clip-flow-indicator'});
        this.add_child(box);

        this._icon = new St.Icon({
            style_class: 'system-status-icon',
            icon_name: 'edit-paste-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);

        this._label = new St.Label({
            style_class: 'clip-flow-indicator-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._label);

        this.connect('button-press-event', () => {
            onClick();
            return Clutter.EVENT_STOP;
        });
        this.connect('touch-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            onClick();
            return Clutter.EVENT_STOP;
        });
    }

    /** `entry` vaut null quand l'historique est vide : on ne garde que l'icône. */
    update(entry) {
        const limit = this._settings.get_int('indicator-max-chars');
        const text = previewFor(entry, limit);

        this._label.text = text;
        this._label.visible = text !== '';
        this.reactive = true;
    }
});
