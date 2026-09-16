#!/usr/bin/env bash
# Installe les extensions GNOME de ce depot dans la session courante.
#
#   ./install.sh            installe tout
#   ./install.sh clip-flow  installe une extension precise
#
# Chaque extension est copiee sous son UUID (lu dans metadata.json), ses
# schemas GSettings sont compiles, puis elle est activee.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$DEST"

uuid_of() {
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$1/metadata.json"
}

install_one() {
    local src="$1" name uuid
    name="$(basename "$src")"

    if [ ! -f "$src/metadata.json" ]; then
        echo "→ $name : projet a part, voir $name/README.md"
        return
    fi

    uuid="$(uuid_of "$src")"
    rm -rf "${DEST:?}/$uuid"
    cp -r "$src" "$DEST/$uuid"

    if [ -d "$DEST/$uuid/schemas" ]; then
        glib-compile-schemas "$DEST/$uuid/schemas"
    fi

    echo "→ $name installee sous $uuid"
}

targets=()
if [ $# -gt 0 ]; then
    for a in "$@"; do targets+=("$ROOT/gnome/$a"); done
else
    for d in "$ROOT"/gnome/*/; do targets+=("${d%/}"); done
fi

for t in "${targets[@]}"; do
    [ -d "$t" ] || { echo "!! introuvable : $(basename "$t")" >&2; exit 1; }
    install_one "$t"
done

echo
echo "Redemarre GNOME Shell pour qu'il decouvre les nouvelles extensions :"
echo "  X11     : Alt+F2, taper r, Entree"
echo "  Wayland : fermer puis rouvrir la session"
echo
echo "Puis active-les :"
for t in "${targets[@]}"; do
    [ -f "$t/metadata.json" ] || continue
    echo "  gnome-extensions enable $(uuid_of "$t")"
done
