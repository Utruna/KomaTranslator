# KomaTranslator Live

Traduction en direct des manhua / manhwa / manga dans le navigateur (Chrome, Edge, Brave…).
Source : chinois, japonais (y compris texte vertical), coréen, anglais. Cible : français, anglais, espagnol, allemand, italien, portugais.

```
Page web ──img──▶ Extension ──octets──▶ Serveur local (127.0.0.1:8765)
                                          ├─ OCR  : PaddleOCR PP-OCRv5
                                          ├─ Trad : Google (défaut) / Claude / Ollama
                                          └─ Inpainting OpenCV (efface le texte)
Page web ◀── image traduite (texte dessiné par l'extension) ◀──┘
```

## Structure

```
server/          serveur local (OCR, traduction, effacement du texte)
extension/       extension Firefox / Chrome / Edge
samples/         pages de test (non versionnées)
legacy/          ancien pipeline Koharu (abandonné, gardé pour référence)
start_server.bat lance le serveur
```

## Installation

1. **Serveur** : double-clic sur `start_server.bat` (utilise le `venv` existant).
   Attends `KomaTranslator Live prêt sur http://127.0.0.1:8765`.
   Au premier usage du coréen / anglais, le modèle OCR correspondant se télécharge (~10 Mo).
2. **Extension**
   - **Firefox** : `about:debugging#/runtime/this-firefox` → *Charger un module complémentaire temporaire* →
     choisir `extension/manifest.json`. Puis clic sur l'icône → **Autoriser l'accès aux sites** (Firefox ne le donne pas d'office),
     et recharger l'onglet.
     ⚠ Un module temporaire disparaît à la fermeture de Firefox (voir plus bas pour l'installer durablement).
   - **Chrome / Edge** : `chrome://extensions` → *Mode développeur* → *Charger l'extension non empaquetée* → dossier `extension/`.
3. Sur le site de lecture : clic sur l'icône de l'extension → **Traduire ce site**, choisir la langue source.
   Raccourci : `Alt+Shift+T`.

Pendant le traitement, l'image a un contour pointillé violet ; le badge de l'icône indique le nombre d'images en cours.
Désactiver le site remet les images d'origine.

## Meilleure traduction (optionnel)

Google est gratuit mais littéral. Édite `server/config.json` puis relance le serveur :

```json
{ "provider": "anthropic", "model": "claude-haiku-5-5", "api_key": "sk-ant-..." }
```

ou en local avec Ollama :

```json
{ "provider": "openai", "base_url": "http://localhost:11434/v1", "model": "qwen2.5:7b", "api_key": "ollama" }
```

Avec un LLM, toute la page est traduite en une requête (contexte entre les bulles, noms cohérents).
En cas d'échec du LLM, repli automatique sur Google.

## Police

L'extension utilise `extension/fonts/font.otf` si présent (non versionné, Anime Ace copiée depuis `legacy/src/police`), sinon Comic Sans.

## Installation permanente sous Firefox

Firefox (version normale) n'accepte que les extensions signées. Deux options :
- **Firefox Developer Edition / Nightly** : dans `about:config`, mettre `xpinstall.signatures.required` à `false`,
  zipper le contenu du dossier `extension/` en `.xpi` et l'installer via `about:addons` → ⚙ → *Installer depuis un fichier*.
- **Signature gratuite (non listée) sur addons.mozilla.org** : créer un compte développeur, puis
  `npx web-ext sign --channel=unlisted -s extension --api-key=... --api-secret=...` → produit un `.xpi` signé installable partout.

## Limites connues

- Les lecteurs qui dessinent les pages dans un `<canvas>` (certains sites officiels) ne sont pas pris en charge, seulement les `<img>`.
- Texte sur fond très chargé : l'effacement peut laisser des traces.
- OCR sur CPU : ~1 à 3 s par image.
