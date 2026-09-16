# OCR Snip

Widget GNOME : clic sur l'icône du panneau → on trace une zone à l'écran → le
texte reconnu part dans le presse-papier. OCR **100 % local**, PaddleOCR
(PP-OCRv5) exécuté en Node via ONNX Runtime. Aucun appel réseau à l'usage.

```
ocr-snip/
├── extension/ocr-snip@esteban.local/   extension GNOME Shell (GJS)
├── server/                             démon Node : le moteur OCR
│   ├── server.js
│   └── models/                         .onnx + dictionnaires (téléchargés)
├── install.sh                          installe l'unité systemd + l'extension
├── fetch-models.sh                     récupère les modèles ONNX
└── ocr-snip.service                    gabarit d'unité systemd --user
```

## Installation

```bash
./install.sh
# puis recharger GNOME Shell : Alt+F2, taper « r », Entrée   (X11)
gnome-extensions enable ocr-snip@esteban.local
```

## Utilisation

| Geste | Effet |
|---|---|
| **Clic gauche** sur l'icône | trace une zone, OCR, copie |
| **Clic droit** | menu : 5 derniers résultats (clic = recopier), paramètres |
| **Échap** pendant la sélection | annule |

## Pourquoi deux processus

GJS est mono-thread : faire tourner un modèle ONNX dans `gnome-shell` gèlerait
tout le bureau le temps de l'inférence. L'extension se contente donc de
sélectionner, capturer et faire un POST ; le démon Node fait le calcul.

Le démon est démarré **à la demande** par l'extension (`systemctl --user start
ocr-snip.service`, ~20 ms) et s'arrête tout seul après 15 min sans requête, pour
ne pas garder ~150 Mo résidents en permanence.

## Capture d'écran

`org.gnome.Shell.Screenshot` en D-Bus est refusé depuis GNOME 41
(`ScreenshotArea is not allowed`). La capture se fait donc *dans* le shell via
`Shell.Screenshot.screenshot_area()`, ce qui marche aussi sous Wayland. La
sélection réutilise `SelectArea` de `ui/screenshot.js` — API privée du shell,
avec un sélecteur de repli maison si elle disparaît d'une version à l'autre.

## Modèles

| Clé | Détection | Reconnaissance | Pour quoi |
|---|---|---|---|
| `fr` *(défaut)* | PP-OCRv5 mobile det | latin PP-OCRv5 mobile rec (836 car.) | français / anglais — seul jeu qui rend `Œ É À €` |
| `latin` | PP-OCRv4 det | latin PP-OCRv3 rec (185 car.) | repli |
| `ch` | PP-OCRv4 det | ch PP-OCRv4 rec (6623 car.) | CJK (livré par npm) |

Les modèles `fr`/`latin` ne sont pas sur npm : `fetch-models.sh` prend les
exports ONNX officiels PaddlePaddle sur Hugging Face. Le dictionnaire v5 n'est
publié que dans `inference.yml`, le script l'en extrait.

**Piège** : `@gutenye/ocr-common` construit son alphabet avec
`[...texte.split('\n'), ' ']`. Un `\r` ou un saut de ligne final dans le
dictionnaire décale l'index du caractère espace et corrompt toute la sortie —
d'où le `sed`/`perl` de normalisation dans `fetch-models.sh`.

## Réglages

Via le menu → *Paramètres*, ou en ligne de commande :

```bash
gsettings --schemadir extension/ocr-snip@esteban.local/schemas \
  set org.gnome.shell.extensions.ocr-snip lang 'ch'
```

### Où atterrissent les captures

Par défaut le PNG est écrit dans le dossier temporaire du système et supprimé
dès que le texte en a été extrait. Le réglage **Dossier des captures** (champ
libre, sélecteur de dossier, ou clé `capture-dir`) permet d'en choisir un
autre ; `~` y est développé et le dossier est créé s'il manque. Un chemin
inutilisable ne fait pas perdre la capture : on retombe sur `/tmp`.

Combiné à **Conserver les captures**, ça donne un dossier d'archives des zones
capturées :

```bash
gsettings --schemadir extension/ocr-snip@esteban.local/schemas \
  set org.gnome.shell.extensions.ocr-snip capture-dir '~/Images/ocr'
```

Les fichiers sont nommés `ocr-snip-AAAAMMJJ-HHMMSS-NNNN.png`.

Le démon lit aussi `OCR_SNIP_PORT`, `OCR_SNIP_LANG`, `OCR_SNIP_IDLE_TIMEOUT`
(secondes, `0` = résident) et `OCR_SNIP_MIN_HEIGHT` dans son unité systemd.

## Qualité constatée

Sur une capture Gmail réelle en mode sombre : accents, `û`, `î`, ligatures et
ponctuation typographique corrects ; ~1,5 s pour une zone de 900×400 px, ~300 à
700 ms pour un snip courant. Seul écart relevé sur une mire de test : la
ligature `Œ` rendue `E`.

Les petites polices sont sur-échantillonnées (lanczos, ×4 max) avant l'OCR :
PP-OCR ramène chaque ligne à 48 px de haut et perd beaucoup sinon.

## Dépannage

```bash
systemctl --user status ocr-snip.service    # état du démon
journalctl --user -u ocr-snip -f            # journal du démon
journalctl -f -o cat /usr/bin/gnome-shell   # erreurs de l'extension
curl localhost:8791/health                  # le démon répond ?
```

Une modification de `extension.js` **ne prend effet qu'après un rechargement
complet du shell** (les modules ES ne sont importés qu'une fois) : Alt+F2 → `r`.

Même règle pour `prefs.js`, mais dans un autre processus : c'est le service
`org.gnome.Shell.Extensions` qui met le module en cache. Tant qu'il tourne, il
ré-affiche la page d'erreur précédente sans relire le fichier — d'où l'illusion
qu'un correctif « ne change rien ». Il faut le redémarrer :

```bash
pkill -f "gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions"
```

Deux pièges GJS rencontrés dans `prefs.js` : `gettext` ne peut pas être appelé
au niveau module (`gettext can only be called from extensions`), et un
initialiseur GObject refuse une propriété à `undefined`.
