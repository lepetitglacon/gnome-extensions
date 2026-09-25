#!/usr/bin/env bash
# Installe les extensions GNOME et les outils de ce depot dans la session courante.
#
#   ./install.sh            installe tout
#   ./install.sh clip-flow  installe une extension (gnome/) ou un outil (outils/) precis
#
# Chaque extension est LIEE (lien symbolique) depuis ce depot vers
# ~/.local/share/gnome-shell/extensions/<uuid>, chaque outil vers ~/.local/bin
# (et son unite systemd --user s'il en a une). Il n'y a donc jamais de copie :
# ce qui est dans le depot est ce qui tourne, et un « git pull » suffit a
# mettre a jour. Le depot doit rester en place.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions"
BIN="$HOME/.local/bin"
UNITS="$HOME/.config/systemd/user"
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

# Un outil outils/<nom> : l'executable <nom> va dans ~/.local/bin, et son
# unite <nom>.service eventuelle est activee (puis relancee, pour prendre le code a jour).
install_tool() {
    local dir="$1" name
    name="$(basename "$dir")"
    mkdir -p "$BIN"
    ln -sfn "$dir/$name" "$BIN/$name"

    if [ -f "$dir/$name.service" ]; then
        mkdir -p "$UNITS"
        ln -sfn "$dir/$name.service" "$UNITS/$name.service"
        systemctl --user daemon-reload
        systemctl --user enable "$name.service" >/dev/null 2>&1
        systemctl --user restart "$name.service"
    fi

    echo "→ $name  ->  $BIN/$name"
}

modules=()
tools=()
if [ $# -gt 0 ]; then
    for a in "$@"; do
        if   [ -d "$ROOT/gnome/$a" ];  then modules+=("$ROOT/gnome/$a")
        elif [ -d "$ROOT/outils/$a" ]; then tools+=("$ROOT/outils/$a")
        else echo "!! introuvable : $a" >&2; exit 1
        fi
    done
else
    for d in "$ROOT"/gnome/*/;  do modules+=("${d%/}"); done
    for d in "$ROOT"/outils/*/; do [ -d "$d" ] && tools+=("${d%/}"); done
fi

for m in "${modules[@]}"; do install_one "$m"; done
for t in "${tools[@]}";   do install_tool "$t"; done

[ ${#modules[@]} -eq 0 ] && exit 0

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
