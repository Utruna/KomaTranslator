# Test de bout en bout (navigateur réel)

`e2e.js` charge l'extension dans Chromium avec un **faux serveur LLM local** (aucune clé, aucun service externe) et vérifie :
traduction, langue source par site, comptage des jetons et du coût, menu (progression, pause, « voir l'original »),
retraduction d'une image (Alt+Maj+clic), mode économie, plafond de dépense, export / import / annulation des séries.

Il utilise Playwright dans Docker (les chemins `/ext` et `/o` y sont montés) :

```
docker run --rm --ipc=host \
  -v "$PWD/extension:/ext:ro" -v "$PWD/tests/e2e/e2e.js:/t/t.js:ro" \
  -v "$HOME/node_modules:/t/node_modules:ro" -v /tmp/kout:/o -w /t \
  mcr.microsoft.com/playwright:v1.47.2-jammy \
  bash -c "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 & sleep 1; DISPLAY=:99 node t.js"
```

`node_modules` doit contenir `playwright@1.47.2` (`npm i playwright@1.47.2` dans un dossier à part). Compter 2 à 3 minutes :
l'OCR en WebAssembly est lent sur une machine sans GPU. Les captures sont écrites dans `/o`.
