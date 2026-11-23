# KomaTranslator Live

Traduction en direct des manhua / manhwa / manga dans le navigateur (Firefox, Chrome, Edge…).
Source : chinois, japonais (y compris texte vertical), coréen, anglais. Cible : français, anglais, espagnol, allemand, italien, portugais.

```
Page web ──img──▶ Extension ──octets──▶ Serveur local (127.0.0.1:8765)
                                          ├─ OCR  : PP-OCRv5 via RapidOCR (ONNX)
                                          ├─ Effacement du texte (inpainting OpenCV) + détection de la bulle
                                          └─ Trad : Ollama (qwen3.5) / Claude / Google + glossaire de série
Page web ◀── image traduite (texte dessiné par l'extension) ◀──┘
```

Ordre de grandeur : ~0,3–0,7 s d'OCR par page, ~1–2 s par bande de webtoon, ~1–5 s de traduction LLM.

## Structure

```
server/          serveur local (OCR, traduction, mémoire de série, cache)
extension/       extension Firefox / Chrome / Edge
tools/           démarrage automatique, paquet .xpi
samples/         pages de test (non versionnées)
legacy/          ancien pipeline Koharu (abandonné, gardé pour référence)
start_server.bat lance le serveur (avec fenêtre)
```

## Installation

1. **Serveur** : double-clic sur `start_server.bat` (utilise le `venv` existant).
   Attendre `KomaTranslator Live prêt sur http://127.0.0.1:8765`.
   Dépendances : `pip install -r requirements.txt` (voir la note dans ce fichier pour OpenCV).
2. **Extension**
   - **Firefox** : `about:debugging#/runtime/this-firefox` → *Charger un module complémentaire temporaire* →
     choisir `extension/manifest.json`. Puis clic sur l'icône → **Autoriser l'accès aux sites**, et recharger l'onglet.
     ⚠ Un module temporaire disparaît à la fermeture de Firefox (voir *Installation permanente*).
   - **Chrome / Edge** : `chrome://extensions` → *Mode développeur* → *Charger l'extension non empaquetée* → dossier `extension/`.
3. Sur le site de lecture : icône de l'extension → **Traduire ce site**, choisir la langue source. Raccourci : `Alt+Shift+T`.

Après une modification du code : relancer le serveur, cliquer *Actualiser* sur l'extension, recharger la page.

## Utilisation

- Contour pointillé violet = image en cours ; le badge de l'icône = nombre d'images en cours.
- Les images à l'écran passent en premier, puis celles en dessous ; celles déjà dépassées en dernier.
- **Survol d'une bulle** : infobulle avec le texte original et la traduction.
- **Alt + clic sur une bulle** : corriger la traduction. La correction est retenue pour la série
  (appliquée à chaque fois que la même phrase réapparaît).
- **↻ Retraduire la page** (popup) : vide le cache et retraduit — à faire après un import de glossaire.
- Désactiver le site remet les images d'origine.
- Les crédits / pubs de scantrad (URL, Discord, « read at… ») ne sont ni effacés ni traduits.

## Traduction

Réglée dans `server/config.json` (modèle : `server/config.example.json`). Relancer le serveur après modification.

| provider | qualité | config |
|---|---|---|
| `ollama` (conseillé) | bonne, locale, gratuite | `"provider": "ollama", "model": "qwen3.5:latest"` (l'appli Ollama doit tourner) |
| `anthropic` | la meilleure | `"provider": "anthropic", "model": "claude-haiku-5-5", "api_key": "sk-ant-..."` |
| `google` | littérale, sans contexte | `"provider": "google"` |

- Toute la page part en une requête (contexte entre bulles). Si le LLM échoue → repli automatique sur Google.
- `"review": true` : 2e passe de relecture (orthographe, conjugaison). Seules les petites corrections sont acceptées
  (une réécriture complète est refusée). Coût : ~1 s par page. Mettre `false` pour aller plus vite.
- Le texte anglais tout en MAJUSCULES (lettrage de scan) est remis en casse normale avant traduction : beaucoup moins de fautes.
- Comparatif sur les pages de test : `qwen3.5` (9.7B) > `qwen2.5:14b` (plus lent, fautes de conjugaison).

Les traductions sont mises en cache sur disque (`server/cache/`, 3000 pages max) : relire un chapitre est instantané.

## Mémoire par série (glossaire, wiki)

La série est déduite de l'URL (`site.com/manga/ma-serie/chapitre-12` → `site.com/manga/ma-serie`).
Pour chaque série, `server/series/<série>.json` contient :
- **glossary** : termes imposés (noms, sorts, lieux, rangs…) avec leur forme d'origine (萧炎, 斗气…) et leur traduction ;
- **summary** : résumé + personnages avec leur genre (pour les pronoms) ;
- **corrections** : traductions corrigées à la main (Alt+clic) ;
- **history** : les 30 dernières répliques traduites (continuité entre les pages).

**Import depuis un wiki** : popup → section *Série* → URL d'une page wiki (Fandom, Wikipédia, Baidu Baike…) →
*Importer le glossaire*. Avec *Inclure les sous-pages*, le navigateur suit jusqu'à 20 liens internes du wiki
(personnages, techniques…). Le LLM extrait le glossaire par lots (~20 s par lot). Les imports se cumulent.

**Voir / modifier le glossaire** (popup) : éditeur complet — termes, résumé, corrections, historique.

## Démarrage automatique (Windows)

- `tools\autostart_on.bat` : le serveur démarre sans fenêtre à l'ouverture de session (journal dans `server.log`).
- `tools\autostart_off.bat` : désactive.

## Installation permanente sous Firefox

Firefox (version normale) n'accepte que les extensions signées. Deux options :
- **Firefox Nightly / Developer Edition** : `about:config` → `xpinstall.signatures.required` = `false`,
  puis `tools\build_xpi.bat` → `dist\komatranslator.xpi` → `about:addons` → ⚙ → *Installer depuis un fichier*.
- **Signature gratuite (non listée) sur addons.mozilla.org** : compte développeur, puis
  `npx web-ext sign --channel=unlisted -s extension --api-key=... --api-secret=...` → `.xpi` signé installable partout.

## Police

L'extension utilise `extension/fonts/font.otf` si présent (non versionné, Anime Ace copiée depuis `legacy/src/police`), sinon Comic Sans.

## Limites connues

- Les lecteurs qui dessinent les pages dans un `<canvas>` (certains sites officiels) ne sont pas pris en charge, seulement les `<img>`.
- Texte sur fond très chargé : l'effacement peut laisser des traces.
- Une bulle coupée entre deux images est traduite en deux morceaux.
- Les termes « Original » d'un glossaire importé d'un wiki anglais sont devinés par le LLM : à vérifier dans l'éditeur.
