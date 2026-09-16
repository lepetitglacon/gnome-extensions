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
| [`gnome/ocr-snip`](gnome/ocr-snip) | Trace une zone à l'écran et copie le texte reconnu (PaddleOCR en local). Embarque aussi son serveur Node, voir son propre README. |

## Installation

```bash
git clone git@github.com:lepetitglacon/gnome-extensions.git
cd gnome-extensions
./install.sh
```

Le script **lie** chaque extension depuis ce dépôt vers
`~/.local/share/gnome-shell/extensions/<uuid>`, et compile ses schémas
GSettings. Il n'y a jamais de copie : ce qui est dans le dépôt est ce qui
tourne. Modifier le dépôt modifie l'extension en place, et un `git pull` suffit
à tout mettre à jour.

En contrepartie, **le dépôt doit rester où il est** : le déplacer ou le
supprimer casse les liens. Pour n'installer qu'une extension :

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

`ocr-snip` a en plus un démon OCR local (serveur Node + modèles PaddleOCR), que
`install.sh` ne gère pas :

```bash
gnome/ocr-snip/setup-server.sh
```

## Développement

Les extensions installées étant des liens vers ce dépôt, il n'y a rien à
recopier après une modification. En revanche le code modifié n'est pris en
compte qu'après un redémarrage du shell : les modules ES sont mis en cache, un
`disable` puis `enable` ne suffit pas.

Pour voir les erreurs d'une extension :

```bash
journalctl --user -b _COMM=gnome-shell -o cat -f
```

Les `schemas/gschemas.compiled` ne sont pas versionnés : ils sont regénérés par
`install.sh` via `glib-compile-schemas`.
