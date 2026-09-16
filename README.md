# gnome-extensions

Mes extensions GNOME Shell, faites maison, pour retrouver le même bureau sur
tous mes PC Zorin.

Testées sur **Zorin OS 18 / GNOME Shell 46**, en X11. Les métadonnées déclarent
GNOME 45 à 48.

## Les extensions

| Dossier | Ce qu'elle fait |
|---|---|
| [`gnome/battery-monitor`](gnome/battery-monitor) | Niveau de batterie des périphériques sans fil (casque, clavier, souris) dans la barre. Affiche le plus faible, détail au clic. |
| [`gnome/clip-flow`](gnome/clip-flow) | Historique de presse-papier façon <kbd>Win</kbd>+<kbd>V</kbd> : <kbd>Super</kbd>+<kbd>V</kbd> ouvre un panneau au curseur, on filtre, on colle. |
| [`gnome/focus-new-window`](gnome/focus-new-window) | Donne le focus aux fenêtres qui demandent l'attention, au lieu de la notification « la fenêtre est prête ». |
| [`gnome/temp-monitor`](gnome/temp-monitor) | Température du CPU et du GPU NVIDIA dans la barre. |
| [`gnome/ocr-snip`](gnome/ocr-snip) | Trace une zone à l'écran et copie le texte reconnu (PaddleOCR en local). Projet à part : extension + serveur Node, voir son propre README. |

## Installation

```bash
git clone git@github.com:lepetitglacon/gnome-extensions.git
cd gnome-extensions
./install.sh
```

Le script copie chaque extension sous son UUID dans
`~/.local/share/gnome-shell/extensions/`, compile ses schémas GSettings, et
affiche la commande d'activation. Pour n'en installer qu'une :

```bash
./install.sh clip-flow
```

GNOME ne découvre une extension neuve qu'après un redémarrage du shell :

- **X11** — <kbd>Alt</kbd>+<kbd>F2</kbd>, taper `r`, <kbd>Entrée</kbd>
- **Wayland** — fermer puis rouvrir la session

Puis :

```bash
gnome-extensions enable battery-monitor@esteban.local
```

`ocr-snip` a besoin de son serveur OCR : il n'est pas géré par `install.sh`,
suivre [`gnome/ocr-snip/README.md`](gnome/ocr-snip/README.md).

## Développement

Le code modifié n'est pris en compte qu'après un redémarrage du shell : les
modules ES sont mis en cache, un `disable` puis `enable` ne suffit pas.

Pour voir les erreurs d'une extension :

```bash
journalctl --user -b _COMM=gnome-shell -o cat -f
```

Les `schemas/gschemas.compiled` ne sont pas versionnés : ils sont regénérés par
`install.sh` via `glib-compile-schemas`.
