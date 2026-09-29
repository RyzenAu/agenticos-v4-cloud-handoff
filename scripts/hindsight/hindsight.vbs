' Hidden launcher for the Hindsight supervisor (M&U, 28 Sep 2026).
' Deployed to D:\hindsight\service\hindsight.vbs. Started by:
'   - Startup\Hindsight.vbs at logon,
'   - the "MU Hindsight supervisor" scheduled task (logon + every 10 minutes; the supervisor's
'     named mutex makes repeat launches exit immediately, and a crash-loop lock stops restarts),
'   - hindsightctl.ps1 start (through WMI, so it never lives inside an agent/Claude session job).
' Usage: wscript.exe hindsight.vbs [profile]   (default profile: pilot)
' python.exe (not pythonw) on purpose: the supervisor needs a hidden console so it can send
' CTRL_BREAK to the API for a graceful shutdown.
Option Explicit
Dim shell, profile, cmd
profile = "pilot"
If WScript.Arguments.Count > 0 Then profile = WScript.Arguments(0)
cmd = Chr(34) & "D:\hindsight\venv\Scripts\python.exe" & Chr(34) & " " & _
      Chr(34) & "D:\hindsight\service\supervisor.py" & Chr(34) & " run --profile " & profile
Set shell = CreateObject("WScript.Shell")
shell.Run cmd, 0, False
