' Starts run-forever.cmd with no console window.  Optional argument: instance name
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
inst = "default"
If WScript.Arguments.Count > 0 Then inst = WScript.Arguments(0)
CreateObject("WScript.Shell").Run """" & here & "\run-forever.cmd"" " & inst, 0, False
