Option Explicit

Dim fso, shell, root, launcher, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = root & "\ChatGPTLocalVoiceBridge.exe"

If Not fso.FileExists(launcher) Then
  MsgBox "ChatGPTLocalVoiceBridge.exe is missing. Run setup-voice-env.cmd first.", vbExclamation, "ChatGPT Local Voice Bridge"
  WScript.Quit 1
End If

command = Chr(34) & launcher & Chr(34)
shell.Run command, 0, False
