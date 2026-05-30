#!/usr/bin/env bash
# FreeMiD native-host installer (Linux).
#
# Installs the freemid binary to ~/.local/bin and registers a Chrome
# Native Messaging manifest so the FreeMiD browser extension can spawn it.
#
# Usage:
#   ./install/install.sh --extension-id <id> [--binary <path>] [--name <host-name>]
#
# Or via env vars:
#   FREEMID_EXTENSION_ID=...  FREEMID_BINARY=...  ./install/install.sh
#
# Re-running is safe — it overwrites the binary and manifest.

set -euo pipefail

HOST_NAME_DEFAULT="com.clicksentinel.freemid"
DEFAULT_EXTENSION_ID="hkhbfipnjmaaookghalliomoejfagppi"

EXTENSION_ID="${FREEMID_EXTENSION_ID:-}"
BINARY_SRC="${FREEMID_BINARY:-}"
HOST_NAME="${FREEMID_HOST_NAME:-$HOST_NAME_DEFAULT}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --extension-id) EXTENSION_ID="$2"; shift 2 ;;
        --binary)       BINARY_SRC="$2";   shift 2 ;;
        --name)         HOST_NAME="$2";    shift 2 ;;
        -h|--help)
            sed -n '2,16p' "$0"; exit 0 ;;
        *)
            echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$EXTENSION_ID" ]]; then
    EXTENSION_ID="$DEFAULT_EXTENSION_ID"
    echo "→ Using default extension ID: $EXTENSION_ID"
    echo "  (pass --extension-id <id> for a different one)"
fi

# Resolve the binary. Default: <repo>/target/release/freemid built by `cargo build --release`.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -z "$BINARY_SRC" ]]; then
    BINARY_SRC="$REPO_ROOT/target/release/freemid"
fi

if [[ ! -x "$BINARY_SRC" ]]; then
    echo "✗ Binary not found at: $BINARY_SRC" >&2
    echo "  Build it first: (cd \"$REPO_ROOT\" && cargo build --release)" >&2
    exit 1
fi

# Install destination.
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
BIN_DST="$BIN_DIR/freemid"
mkdir -p "$BIN_DIR"
install -m 0755 "$BINARY_SRC" "$BIN_DST"
echo "→ Installed binary: $BIN_DST ($(du -h "$BIN_DST" | cut -f1))"

# Build the native-messaging manifest.
MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "FreeMiD — Discord Rich Presence bridge",
  "path": "$BIN_DST",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF
)

# Browser target directories.
BROWSER_DIRS=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/google-chrome-beta/NativeMessagingHosts"
    "$HOME/.config/google-chrome-unstable/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/.config/vivaldi/NativeMessagingHosts"
)

INSTALLED_ANY=0
for dir in "${BROWSER_DIRS[@]}"; do
    parent="$(dirname "$dir")"
    [[ -d "$parent" ]] || continue           # browser not installed → skip
    mkdir -p "$dir"
    target="$dir/$HOST_NAME.json"
    printf '%s\n' "$MANIFEST_JSON" > "$target"
    chmod 0644 "$target"
    echo "→ Registered: $target"
    INSTALLED_ANY=1
done

if [[ "$INSTALLED_ANY" -eq 0 ]]; then
    echo "⚠ No supported browser config directory found." >&2
    echo "  Manifest will be installed to ~/.config/google-chrome anyway." >&2
    dir="$HOME/.config/google-chrome/NativeMessagingHosts"
    mkdir -p "$dir"
    printf '%s\n' "$MANIFEST_JSON" > "$dir/$HOST_NAME.json"
    echo "→ Registered: $dir/$HOST_NAME.json"
fi

echo
echo "✓ FreeMiD native host installed."
echo "  Restart your browser, then reload the FreeMiD extension."
