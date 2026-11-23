@echo off
rem Ancien serveur Python (remplacé par l'OCR intégré à l'extension depuis la v2)
cd /d "%~dp0..\.."
set PYTHONIOENCODING=utf-8
set PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
venv\Scripts\python.exe -u legacy\live-server\server\main.py
pause
