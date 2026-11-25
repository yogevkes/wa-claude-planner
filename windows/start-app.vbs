' Starts WA-Claude Planner (tray icon + background app) without a console window.
'   start-app.vbs [-Open]    -Open also opens the settings page in the browser
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  If a = "-Open" Then args = args & " -Open"
Next
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File """ & here & "\tray.ps1""" & args, 0, False
