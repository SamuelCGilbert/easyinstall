// Builds the PowerShell installer and the .cmd launcher for a selection of apps.
// The script runs on Windows PowerShell 5.1 (what every Windows 10/11 PC has).

// JSON with every non-ASCII character escaped, so the script text stays plain ASCII
// no matter how PowerShell decodes the download.
const asciiJson = v => JSON.stringify(v).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export function buildScript({ apps, selfUrl, siteUrl, kofiUrl, dryRun, unknown }) {
  const payload = apps.map(a => ({
    n: a.name, s: a.source, p: a.pkg, u: a.resolvedUrl || '', a: a.args, d: a.detect, r: a.requires,
    h: a.homepage, e: a.resolveError || '',
  }));
  const data = asciiJson(payload);
  const unknownLine = unknown.length ? `Write-Host 'Skipped unknown or retired app names: ${unknown.join(', ').replace(/'/g, '')}' -ForegroundColor DarkYellow` : '';
  return `# EasyInstall (${siteUrl})
# Installs the apps below, or updates them if they are already installed.
# Run this again any time to update everything.
# Apps: ${apps.map(a => a.name).join(', ').replace(/[^\x20-\x7e]/g, '')}

function Invoke-EasyInstall {
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$SelfUrl = '${selfUrl}'
$DryRun = $${dryRun ? 'true' : 'false'}
$KofiUrl = '${kofiUrl.replace(/'/g, '')}'
$Apps = @'
${data}
'@ | ConvertFrom-Json

Write-Host ''
Write-Host '  EasyInstall' -ForegroundColor Cyan -NoNewline
Write-Host "  $($Apps.Count) apps  -  ${siteUrl.replace(/^https?:\/\//, '')}" -ForegroundColor DarkGray
if ($DryRun) { Write-Host '  Dry run: nothing will be installed or changed.' -ForegroundColor Yellow }
Write-Host ''
${unknownLine}

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin -and -not $DryRun) {
  Write-Host 'EasyInstall needs administrator rights to install apps for everyone on this PC.'
  Write-Host 'Approve the Windows prompt, and the install continues in a new window.'
  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -NoExit -Command \`"irm '$SelfUrl' | iex\`""
  } catch {
    Write-Host 'The administrator prompt was declined, so nothing was installed.' -ForegroundColor Red
  }
  return
}

$LogDir = Join-Path $env:TEMP 'EasyInstall'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir ("log-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
function Log($msg) { Add-Content -Path $Log -Value ("[" + (Get-Date -Format 'HH:mm:ss') + "] " + $msg) }

# ---- Hardware checks for driver and tuning tools
$Gpus = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) -join ' '
$Cpu = (Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1).Name
function Test-Requires($req) {
  switch ($req) {
    'gpu:nvidia' { return $Gpus -match 'NVIDIA' }
    'gpu:amd'    { return $Gpus -match 'AMD|Radeon' }
    'gpu:intel'  { return $Gpus -match 'Intel' }
    'cpu:intel'  { return $Cpu -match 'Intel' }
    'cpu:amd'    { return $Cpu -match 'AMD' }
    default      { return $true }
  }
}

# ---- Installed programs (for apps that update themselves)
function Test-Installed($pattern) {
  $keys = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  return [bool](Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match $pattern } | Select-Object -First 1)
}

# ---- winget
$Script:Winget = $null
function Get-Winget {
  if ($Script:Winget) { return $Script:Winget }
  $c = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($c) { $Script:Winget = $c.Source; return $Script:Winget }
  $p = Get-ChildItem "$env:ProgramFiles\\WindowsApps\\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\\winget.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
  if ($p) { $Script:Winget = $p.FullName; return $Script:Winget }
  if ($DryRun) { return $null }
  Write-Host 'Setting up winget (Windows Package Manager)...' -ForegroundColor DarkGray
  try {
    Install-PackageProvider -Name NuGet -Force -Scope AllUsers -ErrorAction Stop | Out-Null
    Install-Module Microsoft.WinGet.Client -Force -Scope AllUsers -Repository PSGallery -ErrorAction Stop | Out-Null
    Import-Module Microsoft.WinGet.Client -ErrorAction Stop
    Repair-WinGetPackageManager -AllUsers -Latest -ErrorAction Stop | Out-Null
  } catch { Log "winget setup failed: $_" }
  $p = Get-ChildItem "$env:ProgramFiles\\WindowsApps\\Microsoft.DesktopAppInstaller_*_x64__8wekyb3d8bbwe\\winget.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
  if ($p) { $Script:Winget = $p.FullName }
  return $Script:Winget
}

# ---- Chocolatey
function Get-Choco {
  $c = Get-Command choco.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p = Join-Path $env:ProgramData 'chocolatey\\bin\\choco.exe'
  if (Test-Path $p) { return $p }
  if ($DryRun) { return $null }
  Write-Host 'Setting up Chocolatey for apps that are not on winget...' -ForegroundColor DarkGray
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1')) | Out-Null
  } catch { Log "Chocolatey setup failed: $_" }
  if (Test-Path $p) { return $p }
  return $null
}

$Results = New-Object System.Collections.Generic.List[object]
$NeedsRestart = $false
function Add-Result($name, $status, $detail) {
  $Results.Add([pscustomobject]@{ App = $name; Result = $status; Detail = $detail })
  Log "$name : $status $detail"
}

# winget exit codes
$WG_NO_UPGRADE = -1978335189      # 0x8A15002B: already up to date
$WG_ALREADY    = -1978335135      # 0x8A150061: already installed
$WG_REBOOT     = @(3010, 1641, -1978335215)

$i = 0
foreach ($a in $Apps) {
  $i++
  $tag = "[$i/$($Apps.Count)]"
  if ($a.r -and -not (Test-Requires $a.r)) {
    Write-Host "$tag $($a.n): skipped, this PC doesn't have the hardware it's for" -ForegroundColor DarkGray
    Add-Result $a.n 'Skipped' 'Hardware not present'
    continue
  }
  Write-Host "$tag $($a.n)" -ForegroundColor White -NoNewline
  try {
    switch ($a.s) {
      { $_ -in 'winget','msstore' } {
        $wg = Get-Winget
        if (-not $wg) { Write-Host '  winget unavailable' -ForegroundColor Red; Add-Result $a.n 'Failed' 'winget is not available on this PC'; break }
        $src = if ($a.s -eq 'msstore') { 'msstore' } else { 'winget' }
        $common = @('--id', $a.p, '-e', '-s', $src, '--accept-source-agreements', '--disable-interactivity')
        $listed = (& $wg list @common 2>$null | Out-String)
        $installed = $listed -match [regex]::Escape($a.p)
        if ($DryRun) { $verb = if ($installed) { 'would update' } else { 'would install' }; Write-Host "  $verb" -ForegroundColor Yellow; Add-Result $a.n 'Dry run' $verb; break }
        if ($installed) {
          Write-Host '  checking for updates...' -ForegroundColor DarkGray -NoNewline
          & $wg upgrade @common --silent --accept-package-agreements 2>&1 | ForEach-Object { Log "  $_" }
          $code = $LASTEXITCODE
          if ($code -eq 0) { Write-Host '  updated' -ForegroundColor Green; Add-Result $a.n 'Updated' '' }
          elseif ($code -eq $WG_NO_UPGRADE -or $code -eq $WG_ALREADY) { Write-Host '  up to date' -ForegroundColor Green; Add-Result $a.n 'Up to date' '' }
          elseif ($WG_REBOOT -contains $code) { $NeedsRestart = $true; Write-Host '  updated (restart needed)' -ForegroundColor Green; Add-Result $a.n 'Updated' 'Restart needed' }
          else { Write-Host "  update failed ($code)" -ForegroundColor Red; Add-Result $a.n 'Failed' "winget exit code $code" }
        } else {
          Write-Host '  installing...' -ForegroundColor DarkGray -NoNewline
          & $wg install @common --silent --accept-package-agreements 2>&1 | ForEach-Object { Log "  $_" }
          $code = $LASTEXITCODE
          if ($code -eq 0 -or $code -eq $WG_ALREADY -or $code -eq $WG_NO_UPGRADE) { Write-Host '  installed' -ForegroundColor Green; Add-Result $a.n 'Installed' '' }
          elseif ($WG_REBOOT -contains $code) { $NeedsRestart = $true; Write-Host '  installed (restart needed)' -ForegroundColor Green; Add-Result $a.n 'Installed' 'Restart needed' }
          else { Write-Host "  install failed ($code)" -ForegroundColor Red; Add-Result $a.n 'Failed' "winget exit code $code" }
        }
      }
      'choco' {
        $ch = Get-Choco
        if (-not $ch) {
          if ($DryRun) { Write-Host '  would set up Chocolatey, then install' -ForegroundColor Yellow; Add-Result $a.n 'Dry run' 'would install'; break }
          Write-Host '  Chocolatey unavailable' -ForegroundColor Red; Add-Result $a.n 'Failed' 'Chocolatey could not be set up'; break
        }
        $before = (& $ch list $a.p --exact --limit-output 2>$null | Out-String).Trim()
        if ($DryRun) { $verb = if ($before) { 'would update' } else { 'would install' }; Write-Host "  $verb" -ForegroundColor Yellow; Add-Result $a.n 'Dry run' $verb; break }
        Write-Host '  working...' -ForegroundColor DarkGray -NoNewline
        & $ch upgrade $a.p -y --no-progress 2>&1 | ForEach-Object { Log "  $_" }
        $code = $LASTEXITCODE
        $after = (& $ch list $a.p --exact --limit-output 2>$null | Out-String).Trim()
        if ($code -in 0, 3010, 1641) {
          if ($code -ne 0) { $NeedsRestart = $true }
          $status = if (-not $before) { 'Installed' } elseif ($before -ne $after) { 'Updated' } else { 'Up to date' }
          Write-Host "  $($status.ToLower())" -ForegroundColor Green; Add-Result $a.n $status ''
        } else { Write-Host "  failed ($code)" -ForegroundColor Red; Add-Result $a.n 'Failed' "choco exit code $code" }
      }
      'direct' {
        if ($a.d -and (Test-Installed $a.d)) { Write-Host '  already installed (it updates itself)' -ForegroundColor Green; Add-Result $a.n 'Up to date' 'Updates itself'; break }
        if (-not $a.u) { Write-Host '  download link unavailable' -ForegroundColor Red; Add-Result $a.n 'Failed' ("Download link unavailable. Get it from " + $a.h); break }
        if ($DryRun) { Write-Host '  would download and install' -ForegroundColor Yellow; Add-Result $a.n 'Dry run' $a.u; break }
        Write-Host '  downloading...' -ForegroundColor DarkGray -NoNewline
        $file = Join-Path $LogDir (($a.n -replace '[^A-Za-z0-9]', '') + '-setup.exe')
        Invoke-WebRequest -Uri $a.u -OutFile $file -UseBasicParsing -ErrorAction Stop
        Write-Host '  installing...' -ForegroundColor DarkGray -NoNewline
        $argList = if ($a.a) { $a.a } else { $null }
        $p = if ($argList) { Start-Process -FilePath $file -ArgumentList $argList -Wait -PassThru } else { Start-Process -FilePath $file -Wait -PassThru }
        Remove-Item $file -Force -ErrorAction SilentlyContinue
        if ($p.ExitCode -in 0, 3010, 1641) { if ($p.ExitCode -ne 0) { $NeedsRestart = $true }; Write-Host '  installed' -ForegroundColor Green; Add-Result $a.n 'Installed' '' }
        else { Write-Host "  failed ($($p.ExitCode))" -ForegroundColor Red; Add-Result $a.n 'Failed' "Installer exit code $($p.ExitCode)" }
      }
    }
  } catch {
    Write-Host "  failed: $($_.Exception.Message)" -ForegroundColor Red
    Add-Result $a.n 'Failed' $_.Exception.Message
  }
}

Write-Host ''
Write-Host '  Summary' -ForegroundColor Cyan
$Results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
$failed = @($Results | Where-Object { $_.Result -eq 'Failed' }).Count
if ($failed) { Write-Host "  $failed app(s) failed. Details are in $Log" -ForegroundColor Yellow }
if ($NeedsRestart) { Write-Host '  Restart this PC to finish some installs.' -ForegroundColor Yellow }
Write-Host '  Run EasyInstall again any time to update everything.' -ForegroundColor DarkGray
if ($KofiUrl) { Write-Host "  EasyInstall is free. If it saved you time, you can support it at $KofiUrl" -ForegroundColor DarkGray }
Write-Host ''
}
Invoke-EasyInstall
`;
}

export function buildCmd({ selfUrl, count }) {
  // CRLF line endings: cmd.exe misreads some LF-only batch files.
  return [
    '@echo off',
    'title EasyInstall',
    `rem EasyInstall: installs or updates ${count} apps. Run it again any time to update them.`,
    `rem Script: ${selfUrl}`,
    'net session >nul 2>&1',
    'if %errorlevel% neq 0 (',
    '  echo EasyInstall needs administrator rights. Approve the Windows prompt to continue.',
    '  powershell.exe -NoProfile -Command "Start-Process -FilePath \'%~f0\' -Verb RunAs"',
    '  exit /b',
    ')',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm '${selfUrl}' | iex"`,
    'echo.',
    'pause',
    '',
  ].join('\r\n');
}
