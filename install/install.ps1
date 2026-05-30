#Requires -Version 5.1
<#
.SYNOPSIS
    FreeMiD installer for Windows
.DESCRIPTION
    Installs the FreeMiD native host and sets it to run at startup.
.PARAMETER Uninstall
    Remove FreeMiD and its startup entry.
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$BinaryName   = 'freemid.exe'
$InstallDir   = "$env:LOCALAPPDATA\FreeMiD"
$StartupKey   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$ReleaseName  = 'freemid-windows-x86_64.exe'
$ReleaseUrl   = "https://github.com/ClickSentinel/freemid/releases/latest/download/$ReleaseName"
$ReleaseShaUrl = "$ReleaseUrl.sha256"

function Info  { param($msg) Write-Host "[FreeMiD] $msg" -ForegroundColor Green }
function Warn  { param($msg) Write-Host "[FreeMiD] $msg" -ForegroundColor Yellow }
function Fatal { param($msg) Write-Host "[FreeMiD] $msg" -ForegroundColor Red; exit 1 }

# ── Uninstall ──────────────────────────────────────────────────────────────────
if ($Uninstall) {
    Info "Uninstalling FreeMiD..."
    Stop-Process -Name 'freemid' -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $StartupKey -Name 'FreeMiD' -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
    Info "FreeMiD uninstalled."
    exit 0
}

# ── Install ────────────────────────────────────────────────────────────────────
Info "Installing FreeMiD..."

$LocalBuild = Join-Path (Split-Path $PSScriptRoot) "target\release\$BinaryName"
$BinarySrc  = $null

if (Test-Path $LocalBuild) {
    $BinarySrc = $LocalBuild
    Info "Using locally built binary: $BinarySrc"
} else {
    Info "Downloading latest release from GitHub..."
    $TmpPath = Join-Path $env:TEMP $ReleaseName
    $TmpShaPath = Join-Path $env:TEMP "$ReleaseName.sha256"
    try {
        Invoke-WebRequest -Uri $ReleaseUrl -OutFile $TmpPath -UseBasicParsing
        Invoke-WebRequest -Uri $ReleaseShaUrl -OutFile $TmpShaPath -UseBasicParsing

        $ExpectedHash = ((Get-Content $TmpShaPath -TotalCount 1).Split()[0]).Trim().ToLowerInvariant()
        $ActualHash = (Get-FileHash -Algorithm SHA256 -Path $TmpPath).Hash.ToLowerInvariant()

        if ([string]::IsNullOrWhiteSpace($ExpectedHash)) {
            Fatal "Downloaded checksum file is empty or malformed: $TmpShaPath"
        }

        if ($ExpectedHash -ne $ActualHash) {
            Fatal "Checksum verification failed for downloaded binary."
        }

        Info "Checksum verified."
        $BinarySrc = $TmpPath
    } catch {
        Fatal "Download failed: $_`nBuild locally with: cargo build --release"
    }
}

# Copy binary
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$Dest = Join-Path $InstallDir $BinaryName
Copy-Item $BinarySrc $Dest -Force
Info "Installed to $Dest"

# ── Run at login (current user) ───────────────────────────────────────────────
Set-ItemProperty -Path $StartupKey -Name 'FreeMiD' -Value "`"$Dest`""
Info "Added to startup (HKCU Run key)"

# ── Done ───────────────────────────────────────────────────────────────────────
Info ""
Info "Installation complete!"
Info ""
Info "Next steps:"
Info "  1. Start FreeMiD now: Start-Process '$Dest'"
Info "  2. Load the extension in Chrome/Edge from the extension\dist\ folder"
Info "  3. Make sure Discord is running"
Info ""
Info "FreeMiD will start automatically when you log in."
