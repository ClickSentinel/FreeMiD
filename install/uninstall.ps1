# FreeMiD native-host uninstaller for Windows
#
# Removes the FreeMiD native host binary, manifest, and browser registry entries
# under HKCU (no admin required).
#
# One-liner uninstall:
#   irm https://github.com/ClickSentinel/FreeMiD/releases/latest/download/uninstall.ps1 | iex

param(
    [string]$HostName = ($env:FREEMID_HOST_NAME ?? "com.clicksentinel.freemid"),
    [switch]$DryRun,
    [switch]$KeepBinary
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$InstallDir    = Join-Path $env:LOCALAPPDATA "FreeMiD"
$ManifestPath  = Join-Path $InstallDir "$HostName.json"
$BinaryPath    = Join-Path $InstallDir "freemid.exe"

$RegBase = "HKCU:\Software"
$BrowserKeys = @(
    "$RegBase\Google\Chrome\NativeMessagingHosts\$HostName",
    "$RegBase\Google\Chrome Beta\NativeMessagingHosts\$HostName",
    "$RegBase\Chromium\NativeMessagingHosts\$HostName",
    "$RegBase\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "$RegBase\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
    "$RegBase\Vivaldi\NativeMessagingHosts\$HostName"
)

function Remove-IfExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if (Test-Path $Path) {
        Write-Host "-> Removing ${Label}: $Path"
        if (-not $DryRun) {
            Remove-Item -Force -Path $Path
        }
        return $true
    }
    return $false
}

Write-Host "FreeMiD Uninstall"
Write-Host "----------------"

if (Get-Process -Name "freemid" -ErrorAction SilentlyContinue) {
    Write-Host "-> Stopping running freemid.exe process..."
    if (-not $DryRun) {
        Get-Process -Name "freemid" -ErrorAction SilentlyContinue | Stop-Process -Force
    }
}

$removedReg = 0
foreach ($key in $BrowserKeys) {
    if (Test-Path $key) {
        Write-Host "-> Removing registry key: $key"
        if (-not $DryRun) {
            Remove-Item -Path $key -Recurse -Force
        }
        $removedReg++
    }
}

if ($removedReg -eq 0) {
    Write-Host "   (no browser registry entries found)"
}

[void](Remove-IfExists -Path $ManifestPath -Label "manifest")

if ($KeepBinary) {
    Write-Host "-> Keeping binary by request: $BinaryPath"
} else {
    [void](Remove-IfExists -Path $BinaryPath -Label "binary")
}

if ((Test-Path $InstallDir) -and (-not $DryRun)) {
    $hasRemaining = @(Get-ChildItem -Path $InstallDir -Force | Select-Object -First 1).Count -gt 0
    if (-not $hasRemaining) {
        Remove-Item -Path $InstallDir -Force
        Write-Host "-> Removed empty install directory: $InstallDir"
    }
}

Write-Host ""
if ($DryRun) {
    Write-Host "Dry run complete - nothing was actually removed."
} else {
    Write-Host "FreeMiD native host uninstalled."
    Write-Host "You can remove the browser extension from chrome://extensions."
}