import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const REFRESH_SECONDS = 3;

// --- Lecture bas niveau -----------------------------------------------------

function readText(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error(`lecture impossible: ${path}`);
    return new TextDecoder().decode(bytes);
}

// Trouve le dossier hwmon du CPU (Intel coretemp / AMD k10temp), mis en cache.
let _cpuHwmonDir = null;
let _cpuScanned = false;

function findCpuHwmon() {
    if (_cpuScanned)
        return _cpuHwmonDir;
    _cpuScanned = true;
    const base = '/sys/class/hwmon';
    try {
        const dir = Gio.File.new_for_path(base);
        const en = dir.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const p = `${base}/${info.get_name()}`;
            let name = '';
            try {
                name = readText(`${p}/name`).trim();
            } catch (_e) {
                continue;
            }
            if (name === 'coretemp' || name === 'k10temp' || name === 'zenpower') {
                _cpuHwmonDir = p;
                break;
            }
        }
    } catch (_e) {
        _cpuHwmonDir = null;
    }
    return _cpuHwmonDir;
}

function readCpuTemp() {
    const dir = findCpuHwmon();
    if (!dir)
        return null;
    // temp1_input = "Package id 0" sur coretemp, Tctl/Tccd sur AMD.
    for (const f of ['temp1_input', 'temp2_input']) {
        try {
            const raw = parseInt(readText(`${dir}/${f}`).trim(), 10);
            if (!isNaN(raw))
                return Math.round(raw / 1000);
        } catch (_e) { /* essai suivant */ }
    }
    return null;
}

// --- Indicateur -------------------------------------------------------------

const TempIndicator = GObject.registerClass(
class TempIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Temp Monitor', false);

        this._cpu = null;
        this._gpu = null;

        this._label = new St.Label({
            text: '🌡 …',
            yAlign: Clutter.ActorAlign.CENTER,
            style_class: 'temp-monitor-label',
        });
        this.add_child(this._label);

        // Menu déroulant (détails)
        this._cpuItem = new PopupMenu.PopupMenuItem('CPU : …');
        this._gpuItem = new PopupMenu.PopupMenuItem('GPU : …');
        this._cpuItem.sensitive = false;
        this._gpuItem.sensitive = false;
        this.menu.addMenuItem(this._cpuItem);
        this.menu.addMenuItem(this._gpuItem);

        this._render();
    }

    _colorFor(t) {
        if (t === null)
            return 'inherit';
        if (t >= 88)
            return '#ff5555';
        if (t >= 78)
            return '#ffb454';
        return 'inherit';
    }

    _render() {
        const cpuStr = this._cpu === null ? '--' : `${this._cpu}°`;
        const gpuStr = this._gpu === null ? '--' : `${this._gpu}°`;
        this._label.set_text(`🌡 ${cpuStr} · ${gpuStr}`);

        const hottest = Math.max(this._cpu ?? 0, this._gpu ?? 0);
        this._label.set_style(
            `padding: 0 6px; font-weight: 600; color: ${this._colorFor(hottest || null)};`);

        this._cpuItem.label.set_text(
            `CPU : ${this._cpu === null ? 'n/a' : `${this._cpu} °C`}`);
        this._gpuItem.label.set_text(
            `GPU : ${this._gpu === null ? 'n/a' : `${this._gpu} °C`}`);
    }

    refresh() {
        this._cpu = readCpuTemp();
        this._render(); // affiche déjà le CPU sans attendre le GPU

        // GPU : nvidia-smi en asynchrone pour ne jamais bloquer le shell
        try {
            const proc = Gio.Subprocess.new(
                ['nvidia-smi',
                    '--query-gpu=temperature.gpu',
                    '--format=csv,noheader,nounits'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    const v = parseInt((stdout || '').trim().split('\n')[0], 10);
                    this._gpu = isNaN(v) ? null : v;
                } catch (_e) {
                    this._gpu = null;
                }
                this._render();
            });
        } catch (_e) {
            this._gpu = null;
            this._render();
        }
    }
});

// --- Extension --------------------------------------------------------------

export default class TempMonitorExtension extends Extension {
    enable() {
        this._indicator = new TempIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._indicator.refresh();
        this._timeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._indicator.refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    disable() {
        if (this._timeout) {
            GLib.Source.remove(this._timeout);
            this._timeout = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
