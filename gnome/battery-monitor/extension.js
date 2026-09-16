import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import UPowerGlib from 'gi://UPowerGlib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const REFRESH_SECONDS = 60;
const LOW_LEVEL = 20;      // rouge en dessous
const WARN_LEVEL = 40;     // orange en dessous

// --- Sources de données -----------------------------------------------------

// Icône de périphérique selon le type UPower (kind).
function iconForKind(kind) {
    const K = UPowerGlib.DeviceKind;
    switch (kind) {
    case K.MOUSE:          return 'input-mouse-symbolic';
    case K.KEYBOARD:       return 'input-keyboard-symbolic';
    case K.GAMING_INPUT:   return 'input-gaming-symbolic';
    case K.HEADSET:        return 'audio-headset-symbolic';
    case K.HEADPHONES:     return 'audio-headphones-symbolic';
    case K.SPEAKERS:       return 'audio-speakers-symbolic';
    case K.PHONE:          return 'phone-symbolic';
    case K.TABLET:
    case K.PEN:            return 'input-tablet-symbolic';
    default:               return 'battery-symbolic';
    }
}

// Un périphérique sans batterie réelle remonte souvent 0 % / état inconnu
// (ex: l'écran tactile ELAN interne). On l'écarte pour ne pas polluer la liste.
function isBogus(dev) {
    const S = UPowerGlib.DeviceState;
    if (/touchscreen|touchpad/i.test(dev.model || ''))
        return true;
    return dev.percentage === 0 && dev.state === S.UNKNOWN;
}

// Lit les périphériques connus d'UPower (Bluetooth + HID++ pris en charge).
function readUPowerDevices(client) {
    const K = UPowerGlib.DeviceKind;
    const S = UPowerGlib.DeviceState;
    const out = [];

    let devices = [];
    try {
        devices = client.get_devices() || [];
    } catch (_e) {
        return out;
    }

    for (const dev of devices) {
        // On ne garde que les périphériques : ni secteur, ni batterie interne
        // (GNOME affiche déjà celle du portable).
        if (dev.kind === K.LINE_POWER || dev.kind === K.BATTERY)
            continue;
        if (!dev.is_present || isBogus(dev))
            continue;

        out.push({
            name: dev.model || dev.native_path || 'Périphérique',
            percentage: Math.round(dev.percentage),
            charging: dev.state === S.CHARGING || dev.state === S.FULLY_CHARGED,
            icon: iconForKind(dev.kind),
            source: 'upower',
        });
    }
    return out;
}

// --- Indicateur -------------------------------------------------------------

const BatteryIndicator = GObject.registerClass(
class BatteryIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Battery Monitor', false);

        this._devices = [];
        this._rows = [];

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'battery-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '…',
            yAlign: Clutter.ActorAlign.CENTER,
            style_class: 'battery-monitor-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._placeholder = new PopupMenu.PopupMenuItem('Recherche…');
        this._placeholder.sensitive = false;
        this.menu.addMenuItem(this._placeholder);

        this._render();
    }

    _colorFor(p) {
        if (p === null)
            return 'inherit';
        if (p <= LOW_LEVEL)
            return '#ff5555';
        if (p <= WARN_LEVEL)
            return '#ffb454';
        return 'inherit';
    }

    // Icône batterie standard Adwaita, par paliers de 10 %.
    _batteryIcon(p, charging) {
        const step = Math.max(0, Math.min(100, Math.round(p / 10) * 10));
        if (charging)
            return step >= 100 ? 'battery-level-100-charged-symbolic'
                : `battery-level-${step}-charging-symbolic`;
        return `battery-level-${step}-symbolic`;
    }

    _clearRows() {
        for (const row of this._rows)
            row.destroy();
        this._rows = [];
    }

    _render() {
        // --- Barre : le périphérique le plus faible ---
        if (this._devices.length === 0) {
            this._label.set_text('--');
            this._label.set_style('padding: 0 4px; font-weight: 600;');
            this._icon.set_icon_name('battery-symbolic');
        } else {
            const lowest = this._devices.reduce(
                (a, b) => (b.percentage < a.percentage ? b : a));
            this._label.set_text(`${lowest.percentage}%`);
            this._label.set_style(
                `padding: 0 4px; font-weight: 600; color: ${this._colorFor(lowest.percentage)};`);
            this._icon.set_icon_name(
                this._batteryIcon(lowest.percentage, lowest.charging));
        }

        // --- Menu : une ligne par périphérique ---
        this._clearRows();
        if (this._placeholder) {
            this._placeholder.destroy();
            this._placeholder = null;
        }

        if (this._devices.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('Aucun périphérique connecté');
            empty.sensitive = false;
            this.menu.addMenuItem(empty);
            this._rows.push(empty);
            return;
        }

        const sorted = [...this._devices].sort((a, b) => a.percentage - b.percentage);
        for (const dev of sorted) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});

            item.add_child(new St.Icon({
                icon_name: dev.icon,
                style_class: 'popup-menu-icon',
            }));
            item.add_child(new St.Label({
                text: dev.name,
                yAlign: Clutter.ActorAlign.CENTER,
                xExpand: true,
            }));

            const pct = new St.Label({
                text: `${dev.percentage}%${dev.charging ? ' ⚡' : ''}`,
                yAlign: Clutter.ActorAlign.CENTER,
            });
            pct.set_style(`font-weight: 600; color: ${this._colorFor(dev.percentage)};`);
            item.add_child(pct);

            this.menu.addMenuItem(item);
            this._rows.push(item);
        }
    }

    refresh(client) {
        this._devices = readUPowerDevices(client);
        this._render();
    }
});

// --- Extension --------------------------------------------------------------

export default class BatteryMonitorExtension extends Extension {
    enable() {
        this._client = UPowerGlib.Client.new_full(null);

        this._indicator = new BatteryIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._refresh();

        // UPower prévient en direct (connexion/déconnexion Bluetooth).
        this._addedId = this._client.connect('device-added', () => this._refresh());
        this._removedId = this._client.connect('device-removed', () => this._refresh());

        // Filet de sécurité : les niveaux qui bougent sans événement UPower.
        this._timeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _refresh() {
        this._indicator?.refresh(this._client);
    }

    disable() {
        if (this._timeout) {
            GLib.Source.remove(this._timeout);
            this._timeout = null;
        }
        if (this._client) {
            if (this._addedId)
                this._client.disconnect(this._addedId);
            if (this._removedId)
                this._client.disconnect(this._removedId);
            this._addedId = this._removedId = null;
            this._client = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
