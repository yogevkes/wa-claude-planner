# Full stop of WA-Claude Planner: every instance, and it stays stopped after a restart of the computer.
# Leaves stopped.flag in the app folder; Windows-startup launches (tray without -Open, run-forever.cmd)
# see it and exit. Starting the app explicitly (Start menu / start-bot.bat / start.bat) removes it.
# Asks for administrator approval only if something can't be stopped without it.
#   Easiest: double-click stop-bot.bat, the Start-menu entry, or the tray's "full stop".
param([switch]$Elevated)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Add-Type -AssemblyName System.Windows.Forms

function Show-Msg([string]$Text, [string]$Icon = 'Information') {
  [void][System.Windows.Forms.MessageBox]::Show($Text, 'WA-Claude Planner', 'OK', $Icon, 'Button1', 'RightAlign, RtlReading')
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$script:needAdmin = $false
$botPattern = 'tray\.ps1|start-app\.vbs|start-hidden\.vbs|run-forever\.cmd|src\\index\.js'

function Get-BotProcesses {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $botPattern }
}
function Get-RunningTasks {
  Get-ScheduledTask -TaskName 'WA-Claude-Planner*' -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' }
}
function Get-PortOwner {
  Get-NetTCPConnection -LocalPort 3777 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
    Where-Object { $_.ProcessName -eq 'node' }
}
function Stop-Pid([int]$ProcId) {
  try { Stop-Process -Id $ProcId -Force -ErrorAction Stop } catch { $script:needAdmin = $true }
}

# 1. Remember the choice first, so nothing that restarts in the meantime (or after a reboot) comes back
try { Set-Content -LiteralPath (Join-Path $root 'stopped.flag') -Value "stopped $(Get-Date -Format s)" -Encoding ASCII -ErrorAction Stop }
catch { $script:needAdmin = $true }

# 2. The autostart task (it restarts the bot after a crash)
foreach ($t in @(Get-RunningTasks)) {
  try { Stop-ScheduledTask -TaskName $t.TaskName -ErrorAction Stop } catch { $script:needAdmin = $true }
}

# 3. Tray (restarts the app), then the run-forever loop (restarts node), then node itself
foreach ($pat in @('tray\.ps1|start-app\.vbs|start-hidden\.vbs', 'run-forever\.cmd', 'src\\index\.js')) {
  foreach ($p in @(Get-BotProcesses | Where-Object { $_.CommandLine -match $pat })) { Stop-Pid $p.ProcessId }
}
# a bot whose command line can't be read without admin still shows up on the settings port
foreach ($p in @(Get-PortOwner)) { Stop-Pid $p.Id }

Start-Sleep -Seconds 2
$left = @(Get-BotProcesses) + @(Get-RunningTasks) + @(Get-PortOwner)

if (($left.Count -gt 0 -or $script:needAdmin) -and -not $isAdmin -and -not $Elevated) {
  try {
    Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ErrorAction Stop `
      -ArgumentList "-NoProfile -ExecutionPolicy Bypass -STA -File `"$PSCommandPath`" -Elevated"
    exit
  } catch {
    if ($left.Count -gt 0) {
      Show-Msg "חלק מהבוט עדיין פועל, כי לא אושרו הרשאות מנהל.`n`nהוא לא יופעל שוב אחרי הפעלה מחדש של המחשב, אז אפשר פשוט להפעיל מחדש את המחשב." 'Warning'
      exit
    }
  }
}

if ($left.Count -eq 0) {
  Show-Msg "הבוט נעצר לגמרי.`nהוא לא יופעל אוטומטית, גם אחרי הפעלה מחדש של המחשב.`n`nכדי להפעיל אותו שוב: תפריט התחל ← WA-Claude Planner`n(או start-bot.bat בתיקיית התוכנה)."
} else {
  Show-Msg "חלק מהבוט עדיין פועל.`n`nהוא לא יופעל שוב אחרי הפעלה מחדש של המחשב, אז אפשר פשוט להפעיל מחדש את המחשב." 'Warning'
}
