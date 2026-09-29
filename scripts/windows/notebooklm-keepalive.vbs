' Hidden launcher for notebooklm-keepalive.ps1 (no console flash).
' Waits for the script and passes its exit code on, so the scheduled task's "Last Run Result" is the
' real result. Before 28 Sep it returned at once (0x0) while the refresh had failed with exit 2 on
' every run since 25 Sep.
Dim rc
rc = CreateObject("WScript.Shell").Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & Replace(WScript.ScriptFullName, ".vbs", ".ps1") & """", 0, True)
WScript.Quit rc
