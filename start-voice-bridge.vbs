Option Explicit

Dim fso, shell, root, pythonExe, pythonwExe, controller, checkCommand, exitCode, runCommand
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
pythonExe = root & "\local-api\.venv\Scripts\python.exe"
pythonwExe = root & "\local-api\.venv\Scripts\pythonw.exe"
controller = root & "\local-api\tray_controller.py"

If Not fso.FileExists(pythonExe) Or Not fso.FileExists(pythonwExe) Then
  MsgBox "The voice environment is missing. Run setup-voice-env.cmd first.", vbExclamation, "ChatGPT Local Voice Bridge"
  WScript.Quit 1
End If

If Not fso.FileExists(controller) Then
  MsgBox "local-api\tray_controller.py was not found.", vbCritical, "ChatGPT Local Voice Bridge"
  WScript.Quit 1
End If

checkCommand = Chr(34) & pythonExe & Chr(34) & " -c " & Chr(34) & "import pystray; from PIL import Image" & Chr(34)
exitCode = shell.Run(checkCommand, 0, True)
If exitCode <> 0 Then
  MsgBox "Tray dependencies are missing. Run setup-voice-env.cmd again.", vbExclamation, "ChatGPT Local Voice Bridge"
  WScript.Quit exitCode
End If

runCommand = Chr(34) & pythonwExe & Chr(34) & " " & Chr(34) & controller & Chr(34)
shell.Run runCommand, 0, False
