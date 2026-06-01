#!/usr/bin/env bash
# FreeMiD native-host uninstaller
#
# Removes the FreeMiD binary and all native-messaging manifests from
# every supported browser on Linux and macOS.
#
# One-liner uninstall:
#   curl -sSL https://github.com/ClickSentinel/FreeMiD/releases/latest/download/uninstall.sh | bash
#
# Options:
#   --name <host-name>   Override host name (default: com.clicksentinel.freemid)
#   --dry-run            Print what would be removed without actually removing anything
#   -h, --help           Show this help

set -euo pipefail

HOST_NAME="${FREEMID_HOST_NAME:-com.clicksentinel.freemid}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name)    HOST_NAME="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

OS="$(uname -s)"

remove() {
    local path="$1"
    if [[ -e "$path" ]]; then
        echo "→ Removing: $path"
        if [[ "$DRY_RUN" -eq 0 ]]; then
            rm -f "$path"
        fi
    fi
}

# ── Kill running process ───────────────────────────────────────────────────
if pgrep -x freemid &>/dev/null; then
    echo "→ Stopping freemid process…"
    if [[ "$DRY_RUN" -eq 0 ]]; then
        pkill -x freemid || true
        # Give it a moment to exit cleanly before we remove the binary
        sleep 0.5
    fi
fi

# ── Remove binary ──────────────────────────────────────────────────────────
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
BIN_DST="$BIN_DIR/freemid"
remove "$BIN_DST"

# ── Remove native-messaging manifests ─────────────────────────────────────
if [[ "$OS" == Darwin* ]]; then
    MANIFEST_DIRS=(
        "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
        "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
        "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
    )
else
    MANIFEST_DIRS=(
        "$HOME/.config/google-chrome/NativeMessagingHosts"
        "$HOME/.config/google-chrome-beta/NativeMessagingHosts"
        "$HOME/.config/google-chrome-unstable/NativeMessagingHosts"
        "$HOME/.config/chromium/NativeMessagingHosts"
        "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
        "$HOME/.config/vivaldi/NativeMessagingHosts"
    )
fi

REMOVED_ANY=0
for dir in "${MANIFEST_DIRS[@]}"; do
    manifest="$dir/$HOST_NAME.json"
    if [[ -f "$manifest" ]]; then
        remove "$manifest"
        REMOVED_ANY=1
    fi
done

if [[ "$REMOVED_ANY" -eq 0 ]]; then
    echo "  (no native-messaging manifests found)"
fi

echo
if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "Dry run complete — nothing was actually removed."
else
    echo "✓ FreeMiD uninstalled."
    echo "  You may also remove the browser extension manually."
fi
