#!/usr/bin/env bash
# FreeMiD native-host installer
#
# Downloads the correct pre-built binary from GitHub Releases and registers
# it as a Chrome Native Messaging host so the FreeMiD browser extension can
# launch it.
#
# One-liner install (latest release):
#   curl -sSL https://github.com/ClickSentinel/FreeMiD/releases/latest/download/install.sh | bash
#
# With a specific extension ID:
#   curl -sSL .../install.sh | bash -s -- --extension-id <your-id>
#
# With a local binary (skip download):
#   ./install/install.sh --binary ./target/release/freemid
#
# Re-running is safe — overwrites the binary and manifests.

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────
HOST_NAME="${FREEMID_HOST_NAME:-com.clicksentinel.freemid}"
DEFAULT_EXTENSION_ID="hkhbfipnjmaaookghalliomoejfagppi"
GITHUB_REPO="ClickSentinel/FreeMiD"
GITHUB_RELEASES="https://github.com/${GITHUB_REPO}/releases"

# ── Argument parsing ───────────────────────────────────────────────────────
EXTENSION_ID="${FREEMID_EXTENSION_ID:-}"
BINARY_SRC="${FREEMID_BINARY:-}"
RELEASE_TAG="${FREEMID_RELEASE_TAG:-latest}"   # e.g. v0.2.1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --extension-id) EXTENSION_ID="$2"; shift 2 ;;
        --binary)       BINARY_SRC="$2";   shift 2 ;;
        --tag)          RELEASE_TAG="$2";  shift 2 ;;
        --name)         HOST_NAME="$2";    shift 2 ;;
        -h|--help)
            sed -n '2,20p' "$0"; exit 0 ;;
        *)
            echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$EXTENSION_ID" ]]; then
    EXTENSION_ID="$DEFAULT_EXTENSION_ID"
    echo "→ Using default extension ID: $EXTENSION_ID"
fi

# ── Detect platform ────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Linux*)
        case "$ARCH" in
            x86_64)  ARTIFACT="freemid-linux-x86_64" ;;
            *)
                echo "✗ Unsupported Linux architecture: $ARCH" >&2
                echo "  Build from source: cargo build --release" >&2
                exit 1 ;;
        esac
        ;;
    Darwin*)
        case "$ARCH" in
            arm64)  ARTIFACT="freemid-macos-arm64" ;;
            x86_64) ARTIFACT="freemid-macos-x86_64" ;;
            *)
                echo "✗ Unsupported macOS architecture: $ARCH" >&2
                exit 1 ;;
        esac
        ;;
    *)
        echo "✗ Unsupported OS: $OS" >&2
        echo "  Windows users: see README for instructions." >&2
        exit 1 ;;
esac

# ── Resolve / download the binary ─────────────────────────────────────────
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
BIN_DST="$BIN_DIR/freemid"
mkdir -p "$BIN_DIR"

if [[ -n "$BINARY_SRC" ]]; then
    # Local binary provided — skip download.
    if [[ ! -f "$BINARY_SRC" ]]; then
        echo "✗ Binary not found: $BINARY_SRC" >&2
        exit 1
    fi
    install -m 0755 "$BINARY_SRC" "$BIN_DST"
    echo "→ Installed binary (local): $BIN_DST ($(du -h "$BIN_DST" | cut -f1))"
else
    # Download from GitHub Releases.
    if [[ "$RELEASE_TAG" == "latest" ]]; then
        DOWNLOAD_URL="${GITHUB_RELEASES}/latest/download/${ARTIFACT}"
    else
        DOWNLOAD_URL="${GITHUB_RELEASES}/download/${RELEASE_TAG}/${ARTIFACT}"
    fi

    echo "→ Downloading $ARTIFACT from GitHub Releases…"

    if command -v curl &>/dev/null; then
        curl -fsSL --retry 3 -o "$BIN_DST" "$DOWNLOAD_URL"
    elif command -v wget &>/dev/null; then
        wget -q --tries=3 -O "$BIN_DST" "$DOWNLOAD_URL"
    else
        echo "✗ Neither curl nor wget found. Install one and retry." >&2
        exit 1
    fi

    chmod 0755 "$BIN_DST"
    echo "→ Installed binary: $BIN_DST ($(du -h "$BIN_DST" | cut -f1))"

    # ── Verify SHA256 checksum ─────────────────────────────────────────
    echo "→ Verifying checksum…"
    CHECKSUMS_URL="${DOWNLOAD_URL%/*}/checksums.sha256"
    if command -v curl &>/dev/null; then
        CHECKSUMS=$(curl -fsSL --retry 3 "$CHECKSUMS_URL")
    else
        CHECKSUMS=$(wget -q --tries=3 -O- "$CHECKSUMS_URL")
    fi
    EXPECTED=$(echo "$CHECKSUMS" | grep -E "\b${ARTIFACT}$" | awk '{print $1}')
    if [[ -z "$EXPECTED" ]]; then
        echo "✗ Could not find checksum for $ARTIFACT in checksums.sha256" >&2
        rm -f "$BIN_DST"
        exit 1
    fi
    if command -v sha256sum &>/dev/null; then
        ACTUAL=$(sha256sum "$BIN_DST" | awk '{print $1}')
    elif command -v shasum &>/dev/null; then
        ACTUAL=$(shasum -a 256 "$BIN_DST" | awk '{print $1}')
    else
        echo "✗ No sha256sum or shasum available — cannot verify download." >&2
        rm -f "$BIN_DST"
        exit 1
    fi
    if [[ "$ACTUAL" != "$EXPECTED" ]]; then
        echo "✗ Checksum mismatch for $ARTIFACT!" >&2
        echo "  Expected: $EXPECTED" >&2
        echo "  Actual:   $ACTUAL" >&2
        rm -f "$BIN_DST"
        exit 1
    fi
    echo "→ Checksum verified ✓"

# ── Build the native-messaging manifest ───────────────────────────────────
MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "FreeMiD \u2014 Discord Rich Presence bridge",
  "path": "$BIN_DST",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
)

# ── Register with installed browsers ──────────────────────────────────────
if [[ "$OS" == Darwin* ]]; then
    BROWSER_DIRS=(
        "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
        "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
        "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
    )
    BROWSER_PARENT_DIRS=(
        "$HOME/Library/Application Support/Google/Chrome"
        "$HOME/Library/Application Support/Google/Chrome Beta"
        "$HOME/Library/Application Support/Chromium"
        "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
        "$HOME/Library/Application Support/Vivaldi"
    )
else
    BROWSER_DIRS=(
        "$HOME/.config/google-chrome/NativeMessagingHosts"
        "$HOME/.config/google-chrome-beta/NativeMessagingHosts"
        "$HOME/.config/google-chrome-unstable/NativeMessagingHosts"
        "$HOME/.config/chromium/NativeMessagingHosts"
        "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        "$HOME/.config/vivaldi/NativeMessagingHosts"
    )
    BROWSER_PARENT_DIRS=(
        "$HOME/.config/google-chrome"
        "$HOME/.config/google-chrome-beta"
        "$HOME/.config/google-chrome-unstable"
        "$HOME/.config/chromium"
        "$HOME/.config/BraveSoftware/Brave-Browser"
        "$HOME/.config/vivaldi"
    )
fi

INSTALLED_ANY=0
for i in "${!BROWSER_DIRS[@]}"; do
    dir="${BROWSER_DIRS[$i]}"
    parent="${BROWSER_PARENT_DIRS[$i]}"
    [[ -d "$parent" ]] || continue   # browser not installed — skip
    mkdir -p "$dir"
    target="$dir/$HOST_NAME.json"
    printf '%s\n' "$MANIFEST_JSON" > "$target"
    chmod 0644 "$target"
    echo "→ Registered: $target"
    INSTALLED_ANY=1
done

if [[ "$INSTALLED_ANY" -eq 0 ]]; then
    echo "⚠ No supported browser config directory found." >&2
    echo "  Installing manifest to default Chrome location anyway." >&2
    if [[ "$OS" == Darwin* ]]; then
        dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    else
        dir="$HOME/.config/google-chrome/NativeMessagingHosts"
    fi
    mkdir -p "$dir"
    printf '%s\n' "$MANIFEST_JSON" > "$dir/$HOST_NAME.json"
    echo "→ Registered: $dir/$HOST_NAME.json"
fi

echo
echo "✓ FreeMiD native host installed."
echo "  Restart your browser, then reload the FreeMiD extension."
