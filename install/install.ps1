# FreeMiD native-host installer for Windows
#
# Downloads the correct pre-built binary from GitHub Releases and registers
# it as a Chrome Native Messaging host — no admin required (uses HKCU).
#
# One-liner install (latest release):
#   irm https://github.com/ClickSentinel/FreeMiD/releases/latest/download/install.ps1 | iex
#
# With a specific extension ID:
#   $env:FREEMID_EXTENSION_ID = "yourextensionid"; irm .../install.ps1 | iex
#
# With a local binary (skip download):
#   .\install.ps1 -Binary .\freemid.exe
#
# Re-running is safe - overwrites the binary and manifests.

param(
    [string]$ExtensionId = $env:FREEMID_EXTENSION_ID,
    [string]$Binary      = $env:FREEMID_BINARY,
    [string]$Tag         = ($env:FREEMID_RELEASE_TAG ?? "latest"),
    [string]$HostName    = ($env:FREEMID_HOST_NAME   ?? "com.clicksentinel.freemid")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Constants ──────────────────────────────────────────────────────────────────
$DefaultExtensionId = "hkhbfipnjmaaookghalliomoejfagppi"
$GithubRepo        = "ClickSentinel/FreeMiD"
$Artifact          = "freemid-windows-x86_64.exe"

if (-not $ExtensionId) {
    $ExtensionId = $DefaultExtensionId
    Write-Host "-> Using default extension ID: $ExtensionId"
}

# ── Install destination ────────────────────────────────────────────────────────
$InstallDir = Join-Path $env:LOCALAPPDATA "FreeMiD"
$BinDst     = Join-Path $InstallDir "freemid.exe"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ── Resolve / download the binary ─────────────────────────────────────────────
if ($Binary) {
    if (-not (Test-Path $Binary)) {
        Write-Error "Binary not found: $Binary"
        exit 1
    }
    Copy-Item -Force $Binary $BinDst
    Write-Host "-> Installed binary (local): $BinDst"
} else {
    if ($Tag -eq "latest") {
        $DownloadUrl = "https://github.com/$GithubRepo/releases/latest/download/$Artifact"
    } else {
        $DownloadUrl = "https://github.com/$GithubRepo/releases/download/$Tag/$Artifact"
    }

    Write-Host "-> Downloading $Artifact from GitHub Releases..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $wc = New-Object Net.WebClient
    try {
        $wc.DownloadFile($DownloadUrl, $BinDst)
    } catch {
        Write-Error "Download failed: $_"
        exit 1
    }

    $sizeMb = [math]::Round((Get-Item $BinDst).Length / 1MB, 2)
    Write-Host "-> Installed binary: $BinDst ($sizeMb MB)"

    # ── Verify SHA256 checksum ─────────────────────────────────────────────────
    Write-Host "-> Verifying checksum..."
    $ChecksumsUrl = $DownloadUrl -replace [regex]::Escape($Artifact), 'checksums.sha256'
    try {
        $ChecksumData = $wc.DownloadString($ChecksumsUrl)
    } catch {
        Write-Error "Failed to download checksums.sha256: $_"
        Remove-Item $BinDst -Force -ErrorAction SilentlyContinue
        exit 1
    }
    $ExpectedHash = ($ChecksumData -split "`n" |
        Where-Object { $_ -match "\s+$([regex]::Escape($Artifact))$" } |
        Select-Object -First 1) -split '\s+' | Select-Object -First 1
    if (-not $ExpectedHash) {
        Write-Error "Could not find checksum for $Artifact in checksums.sha256"
        Remove-Item $BinDst -Force
        exit 1
    }
    $ActualHash = (Get-FileHash $BinDst -Algorithm SHA256).Hash.ToLower()
    if ($ActualHash -ne $ExpectedHash.ToLower()) {
        Write-Error "Checksum mismatch!`n  Expected: $ExpectedHash`n  Actual:   $ActualHash"
        Remove-Item $BinDst -Force
        exit 1
    }
    Write-Host "-> Checksum verified ✓"
}

# ── Build the manifest JSON ────────────────────────────────────────────────────
$ManifestPath = Join-Path $InstallDir "$HostName.json"
$ManifestJson = @"
{
  "name": "$HostName",
  "description": "FreeMiD - Discord Rich Presence bridge",
  "path": "$($BinDst -replace '\\', '\\')",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$ExtensionId/"
  ]
}
"@
Set-Content -Path $ManifestPath -Value $ManifestJson -Encoding UTF8
Write-Host "-> Manifest: $ManifestPath"

# ── Register with browsers via HKCU (no admin required) ───────────────────────
$RegBase = "HKCU:\Software"

$BrowserKeys = @(
    "$RegBase\Google\Chrome\NativeMessagingHosts\$HostName",
    "$RegBase\Google\Chrome Beta\NativeMessagingHosts\$HostName",
    "$RegBase\Chromium\NativeMessagingHosts\$HostName",
    "$RegBase\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "$RegBase\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
    "$RegBase\Vivaldi\NativeMessagingHosts\$HostName"
)

# Only register browsers whose parent key already exists (i.e. installed).
$RegisteredAny = $false
foreach ($key in $BrowserKeys) {
    $parentKey = Split-Path $key -Parent
    $grandparentKey = Split-Path $parentKey -Parent
    if (-not (Test-Path $grandparentKey)) { continue }

    # Create HKCU:\...\NativeMessagingHosts\com.clicksentinel.freemid
    # and set its default value to the manifest path (Chrome spec).
    New-Item -Force -Path $key | Out-Null
    Set-ItemProperty -Path $key -Name "(Default)" -Value $ManifestPath
    Write-Host "-> Registered: $key"
    $RegisteredAny = $true
}

if (-not $RegisteredAny) {
    Write-Warning "No supported browser registry key found. Registering for Chrome anyway."
    $chromePath = "$RegBase\Google\Chrome\NativeMessagingHosts\$HostName"
    New-Item -Force -Path $chromePath | Out-Null
    Set-ItemProperty -Path $chromePath -Name "(Default)" -Value $ManifestPath
    Write-Host "-> Registered: $chromePath"
}

Write-Host ""
Write-Host "FreeMiD native host installed."
Write-Host "Restart your browser, then reload the FreeMiD extension."
