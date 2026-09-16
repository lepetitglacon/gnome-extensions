#!/usr/bin/env bash
# Installe les extensions GNOME de ce depot dans la session courante.
#
#   ./install.sh            installe tout
#   ./install.sh clip-flow  installe une extension precise
#
# Chaque extension est LIEE (lien symbolique) depuis ce depot vers
# ~/.local/share/gnome-shell/extensions/<uuid>. Il n'y a donc jamais de copie :
# ce qui est dans le depot est ce qui tourne, et un « git pull » suffit a
# mettre a jour. Le depot doit rester en place.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$DEST"

# Ou est le dossier d'extension : a la racine du module, ou sous extension/<uuid>
# pour les projets qui embarquent aussi autre chose (ocr-snip et son serveur).
ext_dir_of() {
    local d="$1"
    [ -f "$d/metadata.json" ] && { echo "$d"; return; }
    local sub
    sub="$(find "$d/extension" -maxdepth 2 -name metadata.json -print -quit 2>/dev/null)"
    [ -n "$sub" ] && echo "$(dirname "$sub")"
}

uuid_of() {
    python3 -c 'import json,sys; print(json.load(open(sys.argv[1]+"/metadata.json"))["uuid"])' "$1"
}

install_one() {
    local module="$1" name src uuid
    name="$(basename "$module")"
    src="$(ext_dir_of "$module")"

    if [ -z "$src" ]; then
        echo "!! $name : aucun metadata.json trouve" >&2
        return 1
    fi

    uuid="$(uuid_of "$src")"
    rm -rf "${DEST:?}/$uuid"
    ln -s "$src" "$DEST/$uuid"
    [ -d "$src/schemas" ] && glib-compile-schemas "$src/schemas"

    echo "→ $name  ->  $uuid"
}

modules=()
if [ $# -gt 0 ]; then
    for a in "$@"; do modules+=("$ROOT/gnome/$a"); done
else
    for d in "$ROOT"/gnome/*/; do modules+=("${d%/}"); done
fi

for m in "${modules[@]}"; do
    [ -d "$m" ] || { echo "!! introuvable : $(basename "$m")" >&2; exit 1; }
    install_one "$m"
done

echo
echo "Redemarre GNOME Shell pour qu'il decouvre les nouvelles extensions :"
echo "  X11     : Alt+F2, taper r, Entree"
echo "  Wayland : fermer puis rouvrir la session"
echo
echo "Puis active-les :"
for m in "${modules[@]}"; do
    src="$(ext_dir_of "$m")"
    [ -n "$src" ] && echo "  gnome-extensions enable $(uuid_of "$src")"
done

if printf '%s\n' "${modules[@]}" | grep -q '/ocr-snip$'; then
    echo
    echo "ocr-snip a besoin de son demon OCR :  gnome/ocr-snip/setup-server.sh"
fi
