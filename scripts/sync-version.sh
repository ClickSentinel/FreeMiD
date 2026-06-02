#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-sync}"
if [[ "$MODE" != "sync" && "$MODE" != "--check" ]]; then
  echo "Usage: $0 [sync|--check]" >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

workspace_version="$({
  awk '
    /^\[workspace\.package\]$/ { in_section=1; next }
    /^\[/ { in_section=0 }
    in_section && $1 == "version" {
      gsub(/"/, "", $3)
      print $3
      exit
    }
  ' Cargo.toml
} || true)"

if [[ -z "$workspace_version" ]]; then
  echo "Could not parse [workspace.package].version from Cargo.toml" >&2
  exit 1
fi

pkg_file="extension/package.json"
ext_manifest_file="extension/public/manifest.json"
setup_manifest_file="installer/freemid-setup.manifest"
installer_cargo_file="installer/Cargo.toml"

extract_json_version() {
  local path="$1"
  perl -ne 'if (/"version"\s*:\s*"([^"]+)"/) { print "$1\n"; exit }' "$path"
}

extract_setup_manifest_version() {
  local path="$1"
  perl -ne 'if (/assemblyIdentity/ .. /\/>/) { if (/version="([0-9]+\.[0-9]+\.[0-9]+)\.0"/) { print "$1\n"; exit } }' "$path"
}

check_mode() {
  local pkg_version ext_manifest_version setup_manifest_version
  pkg_version="$(extract_json_version "$pkg_file")"
  ext_manifest_version="$(extract_json_version "$ext_manifest_file")"
  setup_manifest_version="$(extract_setup_manifest_version "$setup_manifest_file")"

  local failed=0

  if ! grep -q '^version\.workspace\s*=\s*true$' "$installer_cargo_file"; then
    echo "installer/Cargo.toml must use version.workspace = true" >&2
    failed=1
  fi

  if [[ "$pkg_version" != "$workspace_version" ]]; then
    echo "Version mismatch: $pkg_file has $pkg_version but workspace has $workspace_version" >&2
    failed=1
  fi

  if [[ "$ext_manifest_version" != "$workspace_version" ]]; then
    echo "Version mismatch: $ext_manifest_file has $ext_manifest_version but workspace has $workspace_version" >&2
    failed=1
  fi

  if [[ "$setup_manifest_version" != "$workspace_version" ]]; then
    echo "Version mismatch: $setup_manifest_file has $setup_manifest_version but workspace has $workspace_version" >&2
    failed=1
  fi

  if [[ "$failed" -ne 0 ]]; then
    exit 1
  fi

  echo "Version consistency OK: $workspace_version"
}

sync_mode() {
  perl -0777 -i -pe 's/"version"\s*:\s*"[0-9]+\.[0-9]+\.[0-9]+"/"version": "'"$workspace_version"'"/' "$pkg_file"
  perl -0777 -i -pe 's/"version"\s*:\s*"[0-9]+\.[0-9]+\.[0-9]+"/"version": "'"$workspace_version"'"/' "$ext_manifest_file"
  perl -0777 -i -pe 's/version="[0-9]+\.[0-9]+\.[0-9]+\.0"/version="'"$workspace_version"'.0"/' "$setup_manifest_file"

  check_mode
}

if [[ "$MODE" == "--check" ]]; then
  check_mode
else
  sync_mode
fi
