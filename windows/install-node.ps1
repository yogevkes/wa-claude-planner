# Fallback Node.js LTS installer, used by install-prereqs.bat when winget fails.
# Downloads the official MSI from nodejs.org, checks its SHA256 against SHASUMS256.txt,
# and installs it with a verbose log in data\logs\node-install.log (look there for MSI errors like 1603).
# PowerShell's web client is used on purpose: unlike curl it doesn't abort when the PC
# can't reach the certificate revocation servers (curl error 35, CRYPT_E_NO_REVOCATION_CHECK).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes Invoke-WebRequest very slow
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'node-install.log'

$rel = Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1
$ver = $rel.version
$name = "node-$ver-x64.msi"
$base = "https://nodejs.org/dist/$ver"
$msi = Join-Path $env:TEMP $name

Write-Host "Downloading Node.js $ver ..."
Invoke-WebRequest "$base/$name" -OutFile $msi -UseBasicParsing
$sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
$m = [regex]::Match($sums, '([0-9a-fA-F]{64})\s+' + [regex]::Escape($name))
if (-not $m.Success) { throw "No checksum for $name in SHASUMS256.txt" }
if ((Get-FileHash $msi -Algorithm SHA256).Hash -ne $m.Groups[1].Value) {
  Remove-Item $msi -ErrorAction SilentlyContinue
  throw "Checksum mismatch for $name - not installing"
}

Write-Host '[OK] Checksum verified. Installing - approve the Windows permission prompt if it appears...'
$p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qb', '/norestart', '/l*v', "`"$log`"") -Wait -PassThru
Remove-Item $msi -ErrorAction SilentlyContinue
if ($p.ExitCode -in 0, 3010) { Write-Host "[OK] Node.js $ver installed"; exit 0 }
Write-Host "[X] Node.js installer failed with code $($p.ExitCode) - see $log"
exit $p.ExitCode
