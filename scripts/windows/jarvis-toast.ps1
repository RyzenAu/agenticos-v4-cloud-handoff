# Windows toast fallback for a Jarvis event that would have been spoken but no voice client
# is listening (the operator panel isn't open) — see scripts/jarvis-events.ts (the gate that
# decides this) and scripts/windows/jarvis-toast.ts (the caller). Works under the WinRT
# Windows.UI.Notifications API in plain PowerShell 5.1, no module install required.
#
# Title and message are ordinary PowerShell parameters, never string-interpolated into a
# -Command. An event's text can come from anywhere (a session-watch source, a coach, a cron
# job) and must never be treated as anything but inert display text — the same "argv-only
# untrusted text" discipline used elsewhere for anything that reaches a shell.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$AppId = 'Jarvis'
)

$ErrorActionPreference = 'Stop'

try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02
  )
  $textNodes = $template.GetElementsByTagName('text')
  $textNodes.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
  $textNodes.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null

  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
}
catch {
  Write-Error "jarvis-toast: $($_.Exception.Message)"
  exit 1
}
