@echo off
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True
venv\Scripts\python.exe -u server\main.py
pause
