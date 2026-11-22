# Stops the running planner (the restart loop and the node process).
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'run-forever\.cmd' -or $_.CommandLine -match 'src\\index\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "Stopped $($_.ProcessId)" }
