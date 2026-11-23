' Lance le serveur KomaTranslator sans fenêtre (journal dans server.log)
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Environment("Process")("PYTHONIOENCODING") = "utf-8"
sh.Environment("Process")("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK") = "True"
sh.Run "cmd /c venv\Scripts\python.exe -u server\main.py > server.log 2>&1", 0, False
