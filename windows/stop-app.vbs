' Full stop of WA-Claude Planner (all instances); it stays stopped after a restart of the computer.
' Used by the Start-menu entry and stop-bot.bat. Start again from the Start menu (or start-bot.bat).
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File """ & here & "\stop-all.ps1""", 0, False
