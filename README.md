# KomaTranslator

Extension de navigateur qui traduit **en direct** le texte des manhwa / manhua / manga affichés dans la page.
Rien à installer à part l'extension : la lecture du texte (OCR) se fait **dans le navigateur**.

- Source : chinois, japonais (y compris texte vertical), coréen, anglais
- Cible : français, anglais, espagnol, allemand, italien, portugais
- Navigateurs : Firefox, Chrome, Brave, Opera, Edge

```
Image de la page ─▶ OCR PP-OCRv5 (ONNX Runtime WebAssembly, dans le navigateur)
                 ─▶ effacement du texte + détection de la bulle
                 ─▶ traduction : Google (gratuit) / Ollama (local) / API (DeepSeek, OpenAI…) / Claude
                 ─▶ image redessinée avec la traduction
```

Ordre de grandeur : 0,5–2 s d'OCR par page (CPU), + 0,1 s (Google) à 1–2 s (LLM) de traduction.

---

## Installer (pour tes amis)

### Firefox
1. Récupérer le fichier `komatranslator-x.y.z.xpi` (signé, voir *Partager* plus bas).
2. Le glisser-déposer dans une fenêtre Firefox → **Ajouter**.
3. La page d'options s'ouvre : laisser **Google** (gratuit) ou choisir un autre traducteur.

### Chrome / Brave / Opera / Edge
1. Dézipper `komatranslator-x.y.z.zip` dans un dossier qu'on garde (ne pas le supprimer ensuite).
2. Aller sur `chrome://extensions` (Edge : `edge://extensions`) → activer **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** → choisir le dossier dézippé.
   Chrome affiche parfois un avertissement « extensions en mode développeur » au démarrage : c'est normal hors store.

### Utilisation
- Sur le site de lecture : icône de l'extension → **Traduire ce site** (raccourci `Alt+Shift+T`).
- Contour pointillé violet = image en cours ; le badge de l'icône = nombre d'images en cours.
- **Survol d'une bulle** : texte original. **Alt + clic** : corriger la traduction (retenue pour la série).
- **↻ Retraduire la page** : vide le cache et retraduit (après un changement de traducteur ou de glossaire).

## Traducteurs (page d'options)

| Traducteur | Qualité | Ce qu'il faut |
|---|---|---|
| **Google** (défaut) | littérale, sans contexte | rien |
| **Ollama** | bonne, gratuite, locale | [Ollama](https://ollama.com/download) + `ollama pull qwen3.5` + carte graphique 8 Go+ |
| **API compatible OpenAI** | très bonne, quelques centimes / chapitre | clé DeepSeek, OpenAI, OpenRouter, Mistral… |
| **Claude** | la meilleure | clé API Anthropic |

Avec un LLM : toute la page part en une requête (contexte entre bulles), avec le glossaire et les dernières répliques
de la série. La **relecture** (activée par défaut) corrige l'orthographe ; seules les petites corrections sont acceptées.
En cas d'échec du LLM : repli automatique sur Google (le popup affiche l'erreur).

Ollama refuse par défaut les requêtes d'extensions ; l'extension retire l'en-tête concerné automatiquement.
Si le test des options affiche quand même « 403 » : variable d'environnement
`OLLAMA_ORIGINS=moz-extension://*,chrome-extension://*`, puis redémarrer Ollama.

## Mémoire par série

La série est déduite de l'URL (`site.com/manga/ma-serie/chapitre-12` → `site.com/manga/ma-serie`). Pour chaque série
(stockée dans le navigateur) : **glossaire** imposé (noms, sorts, lieux… avec leur forme d'origine 萧炎, 斗气),
**résumé** (personnages, genre pour les pronoms), **corrections** manuelles, **30 dernières répliques**.

- **Import depuis un wiki** (popup → Série, LLM requis) : avec *Inclure les sous-pages*, jusqu'à 20 pages du wiki
  (personnages, techniques…) sont lues ; les imports se cumulent.
- **Voir / modifier le glossaire** : éditeur complet (termes, résumé, corrections, historique).

## Partager (hors store)

```
tools\build.bat         → dist\komatranslator-<version>.zip   (Chrome & co : à dézipper)
tools\sign_firefox.bat  → dist\komatranslator-<version>.xpi   (Firefox : signé, installable d'un clic)
```

**Firefox exige une signature Mozilla**, même pour un partage privé. `sign_firefox.bat` utilise la signature
**« non listée »** : l'extension n'apparaît pas sur le store, la vérification est automatique (quelques minutes),
c'est gratuit. Une seule fois : compte sur addons.mozilla.org + identifiants API
(<https://addons.mozilla.org/developers/addon/api/key/>). Avant chaque nouvelle version, augmenter `version`
dans `extension/manifest.json`.

La police perso `extension/fonts/font.*` (ex. Anime Ace, licence non redistribuable) n'est jamais incluse dans les
paquets : les amis ont Comic Neue (licence OFL).

## Développement

```
extension/
  background.js        orchestration (images, OCR, traduction, cache, messages)
  content.js           détection des images dans la page, rendu de la traduction
  engine/ocr.js        OCR + bulles + effacement (portage JS du pipeline Python)
  engine/models/       PP-OCRv5 mobile : détection, reconnaissance chinois/japonais/anglais, coréen
  lib/translate.js     traducteurs, prompt, relecture
  lib/store.js         mémoire par série (storage.local) + cache des pages (IndexedDB)
  options.*, popup.*, editor.*
tools/                 construction et signature des paquets
legacy/                anciennes versions (pipeline Koharu, serveur Python « Live »)
```

Vue détaillée : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Firefox : le moteur OCR tourne dans la page d'arrière-plan. Chrome : dans un document « offscreen »
(les service workers ne peuvent pas charger ONNX Runtime).
Charger pour tester : Firefox `about:debugging` → *Charger un module temporaire* → `extension/manifest.json` ;
Chrome `chrome://extensions` → *Charger l'extension non empaquetée* → `extension/`.

## Limites connues

- Les lecteurs qui dessinent les pages dans un `<canvas>` ne sont pas pris en charge, seulement les `<img>`.
- Texte sur fond très chargé : l'effacement peut laisser des traces.
- Une bulle coupée entre deux images est traduite en deux morceaux.
- Les termes « Original » d'un glossaire importé d'un wiki anglais sont devinés par le LLM : à vérifier dans l'éditeur.
