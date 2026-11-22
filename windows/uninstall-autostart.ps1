# Removes the autostart task and stops the planner.
& (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'stop.ps1')
Unregister-ScheduledTask -TaskName 'WA-Claude-Planner' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Autostart removed.'
