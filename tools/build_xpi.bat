@echo off
rem Construit dist\komatranslator.xpi (extension Firefox empaquetée).
rem Installation permanente sans signature : Firefox Nightly / Developer Edition,
rem about:config -> xpinstall.signatures.required = false, puis about:addons -> engrenage -> Installer depuis un fichier.
cd /d "%~dp0.."
if not exist dist mkdir dist
del dist\komatranslator.zip dist\komatranslator.xpi 2>nul
powershell -NoProfile -Command "Compress-Archive -Path extension\* -DestinationPath dist\komatranslator.zip -Force"
ren dist\komatranslator.zip komatranslator.xpi
echo Cree : %CD%\dist\komatranslator.xpi
pause
