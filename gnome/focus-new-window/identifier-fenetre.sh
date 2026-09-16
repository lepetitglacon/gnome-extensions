#!/usr/bin/env bash
# Affiche la classe WM et le titre d'une fenetre, pour remplir la liste
# d'exclusions de l'extension focus-new-window.
# Usage : ./identifier-fenetre.sh  puis cliquer sur la fenetre voulue.
set -euo pipefail
echo "Cliquez sur la fenetre a identifier..."
info=$(xprop WM_CLASS _NET_WM_NAME)
echo
echo "$info"
echo
echo "Motif a copier dans les preferences : celui entre guillemets ci-dessus."
