# WA-Claude Planner tray icon: keeps the app running in the background and gives quick access to it.
# Started hidden by start-app.vbs (Start menu / Windows startup). -Open also opens the settings page.
# If the app is already running (e.g. the "start even when nobody is signed in" task), the tray
# only acts as a remote control and doesn't start a second copy.
param([string]$Instance = 'default', [int]$Port = 3777, [switch]$Open)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$base = "http://127.0.0.1:$Port"

# One tray per instance. A second launch (e.g. from the Start menu) just opens the settings page.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\WA-Claude-Planner-Tray-$Instance", [ref]$created)
if (-not $created) {
  if ($Open) { Start-Process $base }
  exit
}

$node = Join-Path $root 'node\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

function Invoke-Api([string]$Method, [string]$Path) {
  try {
    if ($Method -eq 'GET') { return Invoke-RestMethod -Method Get -Uri "$base$Path" -TimeoutSec 4 }
    return Invoke-RestMethod -Method $Method -Uri "$base$Path" -TimeoutSec 8 -Headers @{ 'x-wa-planner' = '1' } -ContentType 'application/json' -Body '{}'
  } catch { return $null }
}
function Invoke-ApiBody([string]$Path, [string]$Json) {
  try { return Invoke-RestMethod -Method Post -Uri "$base$Path" -TimeoutSec 8 -Headers @{ 'x-wa-planner' = '1' } -ContentType 'application/json' -Body $Json } catch { return $null }
}

$script:child = $null      # the node process we started (if we own it)
$script:owned = $false
$script:quitting = $false
$script:restartAt = $null
$script:status = $null
$script:downTicks = 0
$script:wasComplete = $false
$script:badTicks = 0

function Start-App {
  if (Invoke-Api 'GET' '/api/status') { $script:owned = $false; return }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = "src\index.js --instance $Instance"
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($Port -ne 3777) { $psi.EnvironmentVariables['WA_CLAUDE_PORT'] = "$Port" }
  try {
    $script:child = [System.Diagnostics.Process]::Start($psi)
    $script:owned = $true
  } catch {
    $script:icon.ShowBalloonTip(8000, 'WA-Claude Planner', "לא הצלחתי להפעיל את השירות: $($_.Exception.Message)", 'Error')
  }
}

# ---------------- icon + menu ----------------
$script:icon = New-Object System.Windows.Forms.NotifyIcon
$ico = Join-Path $root 'assets\icon.ico'
$script:icon.Icon = if (Test-Path $ico) { New-Object System.Drawing.Icon($ico) } else { [System.Drawing.SystemIcons]::Application }
$script:icon.Text = 'WA-Claude Planner'
$script:icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.RightToLeft = 'Yes'
$miOpen = $menu.Items.Add('פתח את WA-Claude Planner')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miPause = $menu.Items.Add('השהה')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miData = $menu.Items.Add('תיקיית הנתונים והלוגים')
$miRestart = $menu.Items.Add('הפעלה מחדש')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miQuit = $menu.Items.Add('יציאה')
$script:icon.ContextMenuStrip = $menu

$openUi = { Start-Process $base }
$miOpen.add_Click($openUi)
$script:icon.add_DoubleClick($openUi)
$script:icon.add_BalloonTipClicked($openUi)
$miPause.add_Click({
  if ($script:status) {
    $json = if ($script:status.paused) { '{"paused":false}' } else { '{"paused":true}' }
    [void](Invoke-ApiBody '/api/pause' $json)
    Update-Status
  }
})
$miData.add_Click({ if ($script:status) { Start-Process explorer.exe $script:status.dataDir } })
$miRestart.add_Click({ [void](Invoke-Api 'POST' '/api/restart') })
$miQuit.add_Click({
  $script:quitting = $true
  if ($script:owned) {
    [void](Invoke-Api 'POST' '/api/shutdown')
    if ($script:child -and -not $script:child.WaitForExit(8000)) { try { $script:child.Kill() } catch {} }
  }
  $script:icon.Visible = $false
  $script:icon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$menu.add_Opening({
  $miPause.Enabled = [bool]$script:status
  $miPause.Text = if ($script:status -and $script:status.paused) { 'המשך' } else { 'השהה' }
  $miQuit.Text = if ($script:owned) { 'יציאה (עצירת הבוט)' } else { 'סגירת הסמל (הבוט ממשיך לרוץ)' }
})

function Update-Status {
  $st = Invoke-Api 'GET' '/api/status'
  $script:status = $st
  if (-not $st) { $script:icon.Text = 'WA-Claude Planner - לא פעיל'; return }
  $text = if (-not $st.setupComplete) { 'צריך להשלים הגדרה' } elseif ($st.paused) { 'מושהה' } else { 'פעיל' }
  $script:icon.Text = ("WA-Claude Planner - $text").Substring(0, [Math]::Min(63, ("WA-Claude Planner - $text").Length))
  # warn once when a working setup stays broken for ~30s (not on every short reconnect)
  if ($st.setupComplete) { $script:wasComplete = $true; $script:badTicks = 0 }
  elseif ($script:wasComplete) {
    $script:badTicks++
    if ($script:badTicks -eq 6) {
      $script:icon.ShowBalloonTip(10000, 'WA-Claude Planner', 'משהו בחיבורים נותק והבוט לא עובד. לחץ כאן כדי לסדר.', 'Warning')
    }
  }
}

# ---------------- watchdog ----------------
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  if ($script:quitting) { return }
  if ($script:owned -and $script:child -and $script:child.HasExited) {
    if (-not $script:restartAt) {
      # 75 = restart requested from the settings page; anything else waits a bit (crash, or the boot task took over)
      $delay = if ($script:child.ExitCode -eq 75) { 0 } else { 10 }
      $script:restartAt = (Get-Date).AddSeconds($delay)
    }
    if ((Get-Date) -ge $script:restartAt) {
      $script:restartAt = $null
      $script:child = $null
      $script:owned = $false
      Start-App
    }
    return
  }
  Update-Status
  if (-not $script:owned) {
    # remote-control mode: if the other copy goes away for good, take over
    if ($script:status) { $script:downTicks = 0 } else { $script:downTicks++ }
    if ($script:downTicks -ge 4) { $script:downTicks = 0; Start-App }
  }
})

Start-App
if ($Open) {
  # give the server a moment to come up
  for ($i = 0; $i -lt 20 -and -not (Invoke-Api 'GET' '/api/status'); $i++) { Start-Sleep -Milliseconds 500 }
  Start-Process $base
}
Update-Status
$timer.Start()
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
