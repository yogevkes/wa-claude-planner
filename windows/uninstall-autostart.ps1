# Removes the autostart task of one instance and stops it.  uninstall-autostart.ps1 [-Instance roni]
param([string]$Instance = 'default')
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $here 'stop.ps1') -Instance $Instance
$taskName = if ($Instance -ieq 'default') { 'WA-Claude-Planner' } else { "WA-Claude-Planner-$Instance" }
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Autostart '$taskName' removed."
