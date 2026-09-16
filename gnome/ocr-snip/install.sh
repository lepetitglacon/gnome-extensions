#!/usr/bin/env bash
# Installe le démon OCR (unité systemd --user) et l'extension GNOME.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="ocr-snip@esteban.local"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT_DIR="$HOME/.config/systemd/user"

NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { echo "node introuvable dans le PATH" >&2; exit 1; }

echo "==> Dépendances Node"
(cd "$HERE/server" && npm install --registry=https://registry.npmjs.org)

echo "==> Modèles"
"$HERE/fetch-models.sh"

echo "==> Unité systemd"
mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE_BIN|" -e "s|__SERVER__|$HERE/server/server.js|" \
    "$HERE/ocr-snip.service" > "$UNIT_DIR/ocr-snip.service"
systemctl --user daemon-reload
systemctl --user restart ocr-snip.service || true

echo "==> Extension GNOME"
rm -rf "$EXT_DIR"
mkdir -p "$(dirname "$EXT_DIR")"
ln -s "$HERE/extension/$UUID" "$EXT_DIR"
glib-compile-schemas "$HERE/extension/$UUID/schemas"

echo
echo "Installé. Reste à :"
echo "  1. recharger GNOME Shell (Alt+F2 puis « r », ou se déconnecter sous Wayland)"
echo "  2. gnome-extensions enable $UUID"
