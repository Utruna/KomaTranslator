# Architecture de KomaTranslator

Vue d'ensemble pour lire le code. Tout le code utile est dans `extension/` (le dossier `legacy/` est l'ancien pipeline).

## Qui fait quoi

| Fichier | Contexte d'exécution | Rôle |
|---|---|---|
| `content.js` | dans chaque page | repère les `<img>`, demande la traduction, remplace l'image par le rendu final |
| `background.js` | service worker (Chrome) / page de fond (Firefox) | chef d'orchestre : file d'attente, téléchargement, cache, appels OCR et traduction |
| `engine/ocr.js` | page de fond (Firefox) / document offscreen (Chrome, `engine/engine.html` + `offscreen.js`) | OCR + bulles + effacement du texte |
| `lib/translate.js` | background | Google / Ollama / API OpenAI / Claude, prompt, relecture |
| `presets.js` | background, popup, options | réglages par défaut du traducteur, préréglages DeepSeek / Gemini, profils (une clé par traducteur) |
| `lib/store.js` | background | mémoire par série (`storage.local`) + cache des pages (IndexedDB) |
| `popup.*`, `options.*`, `editor.*`, `memoire.*` | pages de l'extension | interface ; parlent au background par messages (`memoire.*`: séries retenues et cache, suppression partielle ou totale) |

Pourquoi deux modes pour l'OCR : les service workers de Chrome ne peuvent pas charger ONNX Runtime (WebAssembly),
donc `background.js` crée un document *offscreen* et lui envoie l'image en base64. Firefox charge le moteur directement.

## Parcours d'une image

```
content.js  processImg()            message { type: "translate", url, pageUrl }
   │
   ▼
background.js  translate()          (file d'attente, 2 images en parallèle)
   1. fetchImage()                  télécharge avec cookies + Referer forcé (declarativeNetRequest)
   2. clé de cache = sha1(image) | langue source | langue cible | fournisseur
   3. cache IndexedDB ?  oui → étape 6
   4. runOcr()  →  KomaOCR.analyze()
        décodage → tranches de 1600 px → détection (DBNet) → lecture (CRNN/CTC)
        → regroupement en bulles → effacement (inpainting) → intérieur de la bulle (fit_box)
   5. KomaTranslate.translateAll()  LLM (+ relecture) ou Google ; l'historique de la série est mis à jour
   6. corrections manuelles de la série appliquées (toujours prioritaires sur le cache)
   │
   ▼  { ok, data: { width, height, blocks[] }, image }
content.js  render()                image d'origine + patchs effacés + texte traduit (canvas) → nouvelle `src`
```

Un **bloc** (une bulle) contient : `text`, `translation`, `box` (texte d'origine), `fit_box` (intérieur de bulle, ou
`null`), `lines`, `bg`/`fg` (couleurs), `patch_box` + `patch` (zone effacée en PNG base64).

## Fiabilité

- Un résultat **dégradé** (repli Google, bulle non traduite : `info.degraded` dans `translateAll`) est affiché mais ni mis
  en cache ni ajouté à l'historique de la série.
- Les requêtes réseau passent par `KomaTranslate.fetchTimeout` : délai maximal (15 s Google, 30 s images et wiki, 60 s API distante, 180 s Ollama local)
  et nouvelles tentatives sur erreur réseau, 429, 502, 503, 504. Un délai dépassé d'une API distante n'est pas retenté :
  on passe directement au repli Google.
- Pour une même série, la phase contexte → traduction → historique est ordonnée (`KomaStore.acquire`) : les images attendent
  leur tour, la plus haute dans la page (`pos`) d'abord.

## Contrôle de la dépense et de la page

- Chaque appel LLM remonte ses jetons (`KomaTranslate.setUsageHook`) ; le background les cumule par jour et par traducteur (`KomaStore.usageAdd`)
  avec le coût estimé (`KomaPresets.costOf`). Le **plafond** (`cfg.dailyCapCents`) est vérifié sous le verrou de série, avant chaque appel : au-delà, repli sur Google
  (résultat marqué dégradé : ni cache ni historique).
- Les content scripts envoient leurs statistiques (`pageStats`, une entrée par frame) ; le menu les lit par `tabStats`. **Pause** : le content script vide sa file et
  prévient le background (`cancelQueue`), qui retire les travaux en attente de l'onglet et annule ceux qui n'ont pas encore atteint l'OCR ou le LLM (`pausedTabs`).
- La langue source se choisit par site (`siteLangs` dans `storage.sync`, repli sur `src`) ; le content script envoie son `host` avec chaque image.

## Messages (`chrome.runtime.sendMessage`)

Réponse : `{ ok: true, ... }` ou `{ ok: false, error }`.

| `type` | Émetteur | Effet |
|---|---|---|
| `translate` | content | traduit une image (file d'attente, badge sur l'icône) |
| `series` / `seriesFull` / `seriesSave` | popup / éditeur | lit ou modifie glossaire, résumé, corrections |
| `importWiki` | popup | extrait glossaire + résumé depuis un wiki (LLM requis) |
| `correct` | content | enregistre une correction manuelle (Alt+clic) |
| `retranslate` | popup / options | vide le cache et relance la page |
| `health` / `testProvider` | popup / options | état et test du traducteur |

## Données

- `storage.sync` : `src`, `tgt`, `sites` (`{ "site.com": true }`).
- `storage.local` : `cfg` (traducteur, clés API) et `series:<clé>` (glossaire, résumé, corrections, 30 dernières répliques).
- IndexedDB `komatranslator` : cache des pages traduites (2000 entrées max).
- La clé de série vient de l'URL : `site.com/manga/ma-serie/chapitre-12` → `site.com/manga/ma-serie`.

## Pièges connus

- Firefox : un `blob:` créé par un script de contenu n'est pas lisible par la page → le rendu y utilise une data URL.
- ONNX Runtime Web n'accepte pas deux `run()` simultanés : `KomaOCR` sérialise tous ses appels.
- Les règles `declarativeNetRequest` (Referer, retrait de `Origin` pour Ollama) ne visent que les requêtes de
  l'extension (`tabIds: [TAB_ID_NONE]`), pas la navigation normale.
