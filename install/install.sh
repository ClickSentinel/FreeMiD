#!/usr/bin/env bash
# FreeMiD installer — Linux
# Usage: bash install/install.sh [--uninstall]
set -euo pipefail

BINARY_NAME="freemid"
INSTALL_DIR="$HOME/.local/bin"
AUTOSTART_DIR="$HOME/.config/autostart"
DESKTOP_FILE="$AUTOSTART_DIR/freemid.desktop"
RELEASE_URL="https://github.com/ClickSentinel/freemid/releases/latest/download/freemid-linux-x86_64"
RELEASE_SHA_URL="${RELEASE_URL}.sha256"
RELEASE_BUNDLE_URL="${RELEASE_URL}.bundle"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()  { echo -e "${GREEN}[FreeMiD]${NC} $*"; }
warn()  { echo -e "${YELLOW}[FreeMiD]${NC} $*"; }
error() { echo -e "${RED}[FreeMiD]${NC} $*" >&2; exit 1; }

# ── Uninstall ──────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--uninstall" ]]; then
  info "Uninstalling FreeMiD..."
  pkill -f "$BINARY_NAME" 2>/dev/null || true
  rm -f "$INSTALL_DIR/$BINARY_NAME"
  rm -f "$DESKTOP_FILE"
  info "FreeMiD uninstalled."
  exit 0
fi

# ── Install ────────────────────────────────────────────────────────────────────
info "Installing FreeMiD..."

# Determine binary source
if [[ -f "target/release/$BINARY_NAME" ]]; then
  BINARY_SRC="target/release/$BINARY_NAME"
  info "Using locally built binary: $BINARY_SRC"
elif command -v curl &>/dev/null; then
  info "Downloading latest release..."
  mkdir -p /tmp/freemid-install
  BINARY_SRC="/tmp/freemid-install/$BINARY_NAME"
  SHA_SRC="/tmp/freemid-install/$BINARY_NAME.sha256"
  BUNDLE_SRC="/tmp/freemid-install/$BINARY_NAME.bundle"
  curl -fsSL "$RELEASE_URL" -o "$BINARY_SRC"
  curl -fsSL "$RELEASE_SHA_URL" -o "$SHA_SRC"

  if ! command -v sha256sum &>/dev/null; then
    error "sha256sum is required to verify downloaded binaries. Install coreutils or build locally."
  fi

  EXPECTED_HASH="$(awk '{print $1}' "$SHA_SRC")"
  ACTUAL_HASH="$(sha256sum "$BINARY_SRC" | awk '{print $1}')"

  if [[ -z "$EXPECTED_HASH" ]]; then
    error "Downloaded checksum file is empty or malformed: $SHA_SRC"
  fi

  if [[ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]]; then
    error "Checksum verification failed for downloaded binary."
  fi

  info "Checksum verified."

  # Cosign signature verification (Sigstore keyless)
  # Ties the binary to the exact release workflow — protects against a compromised
  # GitHub Releases host because the private key never exists (OIDC ephemeral cert).
  if command -v cosign &>/dev/null; then
    info "Verifying cosign signature..."
    curl -fsSL "$RELEASE_BUNDLE_URL" -o "$BUNDLE_SRC"
    cosign verify-blob "$BINARY_SRC" \
      --bundle "$BUNDLE_SRC" \
      --certificate-identity-regexp \
        'https://github\.com/ClickSentinel/freemid/\.github/workflows/release\.yml@refs/' \
      --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
    info "Cosign signature verified."
  else
    warn "cosign not found — SHA256 verified but signature not checked."
    warn "Install cosign for full verification: https://docs.sigstore.dev/cosign/installation"
  fi

  chmod +x "$BINARY_SRC"
else
  error "No built binary found and curl is not available.\nBuild first with: cargo build --release"
fi

# Install binary
mkdir -p "$INSTALL_DIR"
cp "$BINARY_SRC" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"
info "Installed to $INSTALL_DIR/$BINARY_NAME"

# Ensure install dir is in PATH
if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
  warn "$INSTALL_DIR is not in your PATH."
  warn "Add this to your ~/.bashrc or ~/.zshrc:"
  warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ── Autostart (XDG) ───────────────────────────────────────────────────────────
mkdir -p "$AUTOSTART_DIR"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=FreeMiD
Comment=Free Discord Rich Presence for the web
Exec=$INSTALL_DIR/$BINARY_NAME
Icon=discord
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
StartupNotify=false
Terminal=false
EOF

info "Autostart entry created: $DESKTOP_FILE"

# ── Done ───────────────────────────────────────────────────────────────────────
info "Installation complete!"
info ""
info "Next steps:"
info "  1. Start FreeMiD now:   $INSTALL_DIR/$BINARY_NAME &"
info "  2. Load the extension in Chrome/Firefox from the extension/dist/ folder"
info "  3. Make sure Discord is running"
info ""
info "FreeMiD will autostart on next login."
