Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & "C:\Users\Nebula PC\source\repos\AgenticOS-v4\scripts\windows\openclaw-relay.ps1" & Chr(34), 0, False
