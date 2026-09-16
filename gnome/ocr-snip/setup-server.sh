#!/usr/bin/env bash
# Installe le demon OCR d'ocr-snip (dependances Node, modeles, unite systemd).
#
# L'extension GNOME elle-meme n'est PAS geree ici : elle l'est par le
# ./install.sh a la racine du depot, comme toutes les autres.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"

NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { echo "node introuvable dans le PATH" >&2; exit 1; }

echo "==> Dependances Node"
(cd "$HERE/server" && npm install --registry=https://registry.npmjs.org)

echo "==> Modeles"
"$HERE/fetch-models.sh"

echo "==> Unite systemd"
mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE_BIN|" -e "s|__SERVER__|$HERE/server/server.js|" \
    "$HERE/ocr-snip.service" > "$UNIT_DIR/ocr-snip.service"
systemctl --user daemon-reload
systemctl --user restart ocr-snip.service || true

echo
echo "Demon installe. L'extension s'installe depuis la racine du depot :"
echo "  ./install.sh ocr-snip"
