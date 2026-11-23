@echo off
rem Lance le serveur KomaTranslator (sans fenêtre) à chaque ouverture de session Windows.
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\KomaTranslator.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0start_server_hidden.vbs\"'; $s.WorkingDirectory='%~dp0..'; $s.Save()"
echo Demarrage automatique active : %LNK%
echo Le journal du serveur sera dans server.log
pause
