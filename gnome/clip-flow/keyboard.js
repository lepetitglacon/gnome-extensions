/**
 * Clavier virtuel : sert uniquement à envoyer le Ctrl+V final.
 *
 * On passe par un périphérique Clutter plutôt que par `xdotool` : pas de
 * dépendance externe, et l'événement part du seat du shell, donc la fenêtre
 * ciblée le reçoit comme une vraie frappe.
 */
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

// Modificateurs relâchés de force avant la frappe : voir `paste()`.
const MODIFIERS = [
    Clutter.KEY_Super_L, Clutter.KEY_Super_R,
    Clutter.KEY_Control_L, Clutter.KEY_Control_R,
    Clutter.KEY_Shift_L, Clutter.KEY_Shift_R,
    Clutter.KEY_Alt_L, Clutter.KEY_Alt_R,
];

// Terminaux dans lesquels Ctrl+V ne colle pas.
const SHIFT_PASTE_CLASSES = [
    'gnome-terminal-server', 'org.gnome.terminal', 'org.gnome.ptyxis', 'ptyxis',
    'org.gnome.console', 'kgx', 'alacritty', 'kitty', 'konsole', 'xterm',
    'terminator', 'tilix', 'guake', 'wezterm', 'org.wezfurlong.wezterm', 'foot',
    'hyper', 'rxvt', 'urxvt', 'xfce4-terminal',
];

export function needsShiftPaste(wmClass) {
    if (!wmClass)
        return false;
    const needle = wmClass.toLowerCase();
    return SHIFT_PASTE_CLASSES.some(name => needle.includes(name));
}

export class VirtualKeyboard {
    constructor() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }

    destroy() {
        this._device?.run_dispose();
        this._device = null;
    }

    /** `keys` est la liste des modificateurs, la dernière touche est la lettre. */
    tap(keys) {
        if (!this._device)
            return;

        // `notify_keyval` attend des microsecondes de l'horloge monotone.
        // `Clutter.get_current_event_time()` vaut 0 hors traitement d'un
        // événement — c'est-à-dire dans le timeout d'où l'on colle.
        const time = GLib.get_monotonic_time();

        for (const key of keys)
            this._device.notify_keyval(time, key, Clutter.KeyState.PRESSED);

        for (const key of [...keys].reverse())
            this._device.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }

    /**
     * Relâche les modificateurs encore physiquement enfoncés.
     *
     * Sans cela, le Super de Super+V est toujours tenu quand la frappe part :
     * la fenêtre reçoit Super+Ctrl+V, et rien n'est collé.
     */
    releaseModifiers() {
        if (!this._device)
            return;

        const time = GLib.get_monotonic_time();
        for (const key of MODIFIERS)
            this._device.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }

    paste(shift) {
        const keys = [Clutter.KEY_Control_L];
        if (shift)
            keys.push(Clutter.KEY_Shift_L);
        keys.push(Clutter.KEY_v);
        this.tap(keys);
    }
}
