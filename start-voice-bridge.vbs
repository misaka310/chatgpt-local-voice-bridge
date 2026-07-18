Option Explicit

Dim fso, shell, root, pythonExe, pythonwExe, controller, checkCommand, exitCode, runCommand
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
pythonExe = root & "\local-api\.venv\Scripts\python.exe"
pythonwExe = root & "\local-api\.venv\Scripts\pythonw.exe"
controller = root & "\local-api\tray_controller.py"

If Not fso.FileExists(pythonExe) Or Not fso.FileExists(pythonwExe) Then
  MsgBox "音声環境がありません。先に setup-voice-env.cmd を実行してください。", vbExclamation, "ChatGPT Local Voice Bridge"
  WScript.Quit 1
End If

If Not fso.FileExists(controller) Then
  MsgBox "local-api\tray_controller.py が見つかりません。", vbCritical, "ChatGPT Local Voice Bridge"
  WScript.Quit 1
End If

checkCommand = Chr(34) & pythonExe & Chr(34) & " -c " & Chr(34) & "import pystray; from PIL import Image" & Chr(34)
exitCode = shell.Run(checkCommand, 0, True)
If exitCode <> 0 Then
  MsgBox "通知領域用の依存関係がありません。setup-voice-env.cmd をもう一度実行してください。", vbExclamation, "ChatGPT Local Voice Bridge"
  WScript.Quit exitCode
End If

runCommand = Chr(34) & pythonwExe & Chr(34) & " " & Chr(34) & controller & Chr(34)
shell.Run runCommand, 0, False
