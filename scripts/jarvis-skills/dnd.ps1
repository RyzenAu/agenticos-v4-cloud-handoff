# Windows 11 "Do not disturb", read or set through the Settings page itself (UI Automation), the
# only route that really mutes notifications: the old registry value is a cached copy the shell
# ignores until sign-out. Used by pc-control.ts ("mute notifications", "notifications back on").
#
#   powershell -File dnd.ps1 -Want on|off|read
# Prints one line: "on", "off", "none" (no such switch) or "error: …".
# Opens Settings on the Notifications page only when it wasn't open; closes it again only then.
param([ValidateSet('on', 'off', 'read')][string]$Want = 'read')
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $wasOpen = @(Get-Process SystemSettings -ErrorAction SilentlyContinue).Count -gt 0
  Start-Process 'ms-settings:notifications'
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $isSettings = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'ApplicationFrameWindow')),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Settings')))
  $isSwitch = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Do not disturb')
  $win = $null; $sw = $null
  for ($i = 0; $i -lt 40 -and -not $sw; $i++) {
    Start-Sleep -Milliseconds 250
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $isSettings)
    if ($win) {
      foreach ($e in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isSwitch)) {
        $p = $null
        if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $sw = $e; $toggle = $p; break }
      }
    }
  }
  if (-not $sw) { 'none' } else {
    $state = if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { 'on' } else { 'off' }
    if ($Want -ne 'read' -and $state -ne $Want) {
      $toggle.Toggle(); Start-Sleep -Milliseconds 400
      $state = if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { 'on' } else { 'off' }
    }
    $state
  }
  # Only a Settings window this script opened is closed.
  if (-not $wasOpen -and $win) {
    $wp = $null
    if ($win.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) { $wp.Close() }
  }
} catch { 'error: ' + $_.Exception.Message }
