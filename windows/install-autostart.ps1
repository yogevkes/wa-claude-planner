# Registers the Task Scheduler task that keeps the planner running.
#   Startup (default): starts when the PC boots, even if nobody logs in (survives Windows Update restarts).
#   Logon:             starts when you log in (use this if Startup mode has trouble).
# Easiest: double-click install-autostart.bat (asks for admin approval once).
param([ValidateSet('Startup', 'Logon')][string]$Mode = 'Startup')
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode $Mode"
  exit
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$user = "$env:USERDOMAIN\$env:USERNAME"
if ($Mode -eq 'Startup') {
  $runner = Join-Path $here 'run-forever.cmd'
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$runner`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
} else {
  $vbs = Join-Path $here 'start-hidden.vbs'
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# Stop any copy that is already running (e.g. start.bat) so two bots don't share one WhatsApp session
& (Join-Path $here 'stop.ps1')
Register-ScheduledTask -TaskName 'WA-Claude-Planner' -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'WhatsApp self-group -> Claude -> Google Calendar' -Force | Out-Null
Start-ScheduledTask -TaskName 'WA-Claude-Planner'

Write-Host ""
Write-Host "Installed ($Mode mode) and started. Logs: data\logs\app.log"
Write-Host "Reminder: set Sleep to 'Never' (Settings > System > Power). Screen lock is fine."
Write-Host "Test: send a message in your WhatsApp group in ~30 seconds."
Read-Host "Press Enter to close"
