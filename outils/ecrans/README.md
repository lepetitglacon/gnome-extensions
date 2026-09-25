# ecrans

Retient la disposition des écrans (position, résolution, fréquence, échelle,
écran principal) pour chaque jeu d'écrans branchés, et la réapplique toute seule
quand GNOME l'oublie.

## Pourquoi GNOME oublie

Mutter range ses dispositions (`~/.config/monitors.xml`) par **nom de
connecteur** + EDID. Derrière un dock DisplayLink ou MST, le nom du connecteur
change d'un branchement à l'autre (`DVI-I-1`, `DVI-I-2-1`, `DVI-I-3-2`…) :
GNOME croit voir un nouveau montage et repart sur sa disposition par défaut
(tout en ligne, écran interne principal, 60 Hz).

`ecrans` identifie chaque écran par son EDID seul (fabricant, modèle, n° de
série), jamais par son connecteur. Couvercle fermé, l'écran interne ne fait pas
partie du montage : « dock couvercle ouvert » et « dock couvercle fermé » sont
deux profils distincts.

## Utilisation

Arranger ses écrans une fois dans Paramètres, puis :

```bash
ecrans save bureau
```

À refaire une fois par lieu. Ensuite le service `ecrans.service` s'en occupe.

| Commande | Effet |
|---|---|
| `ecrans` / `ecrans status` | écrans branchés, profil reconnu, disposition en place ou non |
| `ecrans save [nom]` | enregistre la disposition actuelle (remplace le profil du même jeu d'écrans) |
| `ecrans apply [nom]` | réapplique à la main ; `--dry-run` fait seulement valider par GNOME |
| `ecrans list` | liste les profils |
| `ecrans forget <nom>` | supprime un profil |
| `ecrans watch` | ce que fait le service |

Les profils sont dans `~/.config/ecrans/profiles.json`, propres à chaque PC
(l'écran interne change d'une machine à l'autre) : ils ne sont pas versionnés.

## Le service

À chaque (dé)branchement, il attend 2 s que le dock ait fait apparaître tous
ses écrans, puis applique le profil du jeu d'écrans s'il y en a un. Il défend
la disposition pendant 15 s (GNOME la réécrase parfois une seconde fois), puis
laisse faire les changements manuels.

```bash
journalctl --user -u ecrans -f
```

Passe par l'API D-Bus `org.gnome.Mutter.DisplayConfig` : marche sous Wayland
comme sous X11, sans `xrandr`. Testé sur GNOME Shell 46 / Wayland.
