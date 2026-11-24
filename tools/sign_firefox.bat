@echo off
rem Signe l'extension pour Firefox en mode "non listé" (n'apparaît PAS sur le store Mozilla).
rem Le .xpi signé obtenu dans dist\ s'installe d'un clic dans n'importe quel Firefox.
rem
rem Une seule fois : créer un compte sur https://addons.mozilla.org puis générer des identifiants API ici :
rem   https://addons.mozilla.org/developers/addon/api/key/
rem et les renseigner ci-dessous (ou en variables d'environnement AMO_KEY / AMO_SECRET).
rem
rem Avant chaque nouvelle version : augmenter "version" dans extension\manifest.json (Mozilla refuse 2 fois la même).
cd /d "%~dp0.."
if "%AMO_KEY%"=="" set /p AMO_KEY=Identifiant JWT (user:xxxx:xxx) :
if "%AMO_SECRET%"=="" set /p AMO_SECRET=Secret JWT :
call npx --yes web-ext@10 sign --channel=unlisted --source-dir=extension --artifacts-dir=dist ^
  --ignore-files "fonts/font.*" --api-key=%AMO_KEY% --api-secret=%AMO_SECRET%
if errorlevel 1 goto echec
echo.
echo Le fichier .xpi signe est dans le dossier dist\ : envoie-le a tes amis (glisser-deposer dans Firefox).
pause
exit /b 0

:echec
echo.
echo ECHEC : aucun .xpi n'a ete cree. Lis le message d'erreur ci-dessus.
echo  - "Unknown JWT iss" : l'identifiant JWT (user:...) est faux ou a ete regenere.
echo  - "Version already exists" : augmente "version" dans extension\manifest.json.
pause
exit /b 1
