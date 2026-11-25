# Stops a running instance (its restart loop and node process).
#   stop.ps1                       -> default instance
#   stop.ps1 -Instance roni        -> only roni
#   stop.ps1 -All                  -> every instance
#   stop.ps1 -All -IncludeTray     -> also close the tray icon(s) (used by the installer / uninstaller)
param([string]$Instance = 'default', [switch]$All, [switch]$IncludeTray)
$procs = Get-CimInstance Win32_Process
if ($IncludeTray) {
  # the tray restarts the app, so it goes first
  $procs | Where-Object { $_.CommandLine -match 'tray\.ps1' } | ForEach-Object {
    $inst = if ($_.CommandLine -match '-Instance\s+"?([A-Za-z0-9_-]+)') { $Matches[1] } else { 'default' }
    if ($All -or $inst -ieq $Instance) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "Closed tray $inst (pid $($_.ProcessId))"
    }
  }
}
$procs |
  Where-Object { $_.CommandLine -match 'run-forever\.cmd' -or $_.CommandLine -match 'src\\index\.js' } |
  ForEach-Object {
    $cl = $_.CommandLine
    if ($cl -match '--instance\s+"?([A-Za-z0-9_-]+)') { $inst = $Matches[1] }
    elseif ($cl -match 'run-forever\.cmd"?\s+"?([A-Za-z0-9_-]+)') { $inst = $Matches[1] }
    else { $inst = 'default' }
    if ($All -or $inst -ieq $Instance) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped $inst (pid $($_.ProcessId))"
    }
  }
