# Registers the Task Scheduler task that keeps one instance running.
#   Startup (default): starts when the PC boots, even if nobody logs in (survives Windows Update restarts).
#   Logon:             starts when you log in (use this if Startup mode has trouble).
# Easiest: double-click install-autostart.bat (or: install-autostart.bat roni).
param([ValidateSet('Startup', 'Logon')][string]$Mode = 'Startup', [string]$Instance = 'default')
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode $Mode -Instance $Instance"
  exit
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$user = "$env:USERDOMAIN\$env:USERNAME"
$taskName = if ($Instance -ieq 'default') { 'WA-Claude-Planner' } else { "WA-Claude-Planner-$Instance" }
if ($Mode -eq 'Startup') {
  $runner = Join-Path $here 'run-forever.cmd'
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$runner`" $Instance`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
} else {
  $vbs = Join-Path $here 'start-hidden.vbs'
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`" $Instance"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# Stop a copy of this instance that is already running (e.g. start.bat) - two copies can't share one WhatsApp link
& (Join-Path $here 'stop.ps1') -Instance $Instance
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description "WA-Claude Planner ($Instance)" -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "Installed '$taskName' ($Mode mode) and started."
Write-Host "Reminder: set Sleep to 'Never' (Settings > System > Power). Screen lock is fine."
Write-Host "Test: send a message in the WhatsApp self-group in ~30 seconds."
Read-Host "Press Enter to close"
