#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-start}"
if [[ "$MODE" != "start" && "$MODE" != "stop" && "$MODE" != "status" ]]; then
  cat >&2 <<'USAGE'
Usage: ./scripts/local-update-e2e.sh [start|stop|status]

start  Build candidate host, prepare local feed, start local HTTP server, and build extension with update overrides.
stop   Stop local feed HTTP server.
status Show local feed status and test URLs.
USAGE
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FEED_DIR="${FREEMID_E2E_FEED_DIR:-/tmp/freemid-feed}"
PORT="${FREEMID_E2E_PORT:-8787}"
PID_FILE="${FEED_DIR}/.server.pid"
LATEST_PATH="${FEED_DIR}/latest.json"
EXT_DIR="${ROOT_DIR}/extension"

workspace_version="$({
  awk '
    /^\[workspace\.package\]$/ { in_section=1; next }
    /^\[/ { in_section=0 }
    in_section && $1 == "version" {
      gsub(/"/, "", $3)
      print $3
      exit
    }
  ' "${ROOT_DIR}/Cargo.toml"
} || true)"

if [[ -z "$workspace_version" ]]; then
  echo "Could not parse workspace version from Cargo.toml" >&2
  exit 1
fi

release_tag="v${workspace_version}"

artifact_name() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)
      if [[ "$arch" == "x86_64" ]]; then
        echo "freemid-linux-x86_64"
      else
        echo "Unsupported Linux architecture: ${arch}" >&2
        exit 1
      fi
      ;;
    Darwin)
      if [[ "$arch" == "arm64" ]]; then
        echo "freemid-macos-arm64"
      elif [[ "$arch" == "x86_64" ]]; then
        echo "freemid-macos-x86_64"
      else
        echo "Unsupported macOS architecture: ${arch}" >&2
        exit 1
      fi
      ;;
    *)
      echo "Unsupported OS for local updater feed: ${os}" >&2
      exit 1
      ;;
  esac
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

stop_server() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No local feed server pid file found at ${PID_FILE}."
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_pid_running "$pid"; then
    kill "$pid"
    echo "Stopped local feed server (pid ${pid})."
  else
    echo "Local feed server not running (stale pid ${pid:-unknown})."
  fi
  rm -f "$PID_FILE"
}

status_server() {
  local latest_url releases_base
  latest_url="http://127.0.0.1:${PORT}/latest.json"
  releases_base="http://127.0.0.1:${PORT}"

  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_pid_running "$pid"; then
      echo "Local feed server: running (pid ${pid})"
    else
      echo "Local feed server: not running (stale pid ${pid:-unknown})"
    fi
  else
    echo "Local feed server: not running"
  fi

  echo "Feed directory: ${FEED_DIR}"
  echo "Latest URL: ${latest_url}"
  echo "Releases base URL: ${releases_base}"
  echo "Current test tag: ${release_tag}"
}

compare_versions() {
  local a="$1" b="$2"
  awk -v a="$a" -v b="$b" 'BEGIN {
    split(a, A, "."); split(b, B, ".");
    for (i = 1; i <= 3; i++) {
      ai = (A[i] == "" ? 0 : A[i]) + 0;
      bi = (B[i] == "" ? 0 : B[i]) + 0;
      if (ai > bi) { print 1; exit }
      if (ai < bi) { print -1; exit }
    }
    print 0
  }'
}

prepare_feed() {
  local artifact candidate_bin tag_dir
  artifact="$(artifact_name)"
  candidate_bin="${ROOT_DIR}/target/release/freemid"
  tag_dir="${FEED_DIR}/${release_tag}"

  echo "Building candidate native host..."
  (cd "$ROOT_DIR" && cargo build --release -p freemid)

  if [[ ! -f "$candidate_bin" ]]; then
    echo "Candidate binary missing: ${candidate_bin}" >&2
    exit 1
  fi

  mkdir -p "$tag_dir"
  cp "$candidate_bin" "${tag_dir}/${artifact}"
  chmod 0755 "${tag_dir}/${artifact}"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$tag_dir" && sha256sum "$artifact" > checksums.sha256)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$tag_dir" && shasum -a 256 "$artifact" | awk '{print $1"  "$2}' > checksums.sha256)
  else
    echo "Need sha256sum or shasum to generate checksums.sha256" >&2
    exit 1
  fi

  cat > "$LATEST_PATH" <<JSON
{ "tag_name": "${release_tag}" }
JSON

  echo "Prepared feed in ${tag_dir}"
}

start_server() {
  mkdir -p "$FEED_DIR"

  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_pid_running "$pid"; then
      echo "Local feed server already running (pid ${pid})."
      return 0
    fi
    rm -f "$PID_FILE"
  fi

  echo "Starting local feed server on 127.0.0.1:${PORT}..."
  nohup python3 -m http.server "$PORT" --directory "$FEED_DIR" >/tmp/freemid-feed-http.log 2>&1 &
  echo $! > "$PID_FILE"

  local pid
  pid="$(cat "$PID_FILE")"
  if ! is_pid_running "$pid"; then
    echo "Failed to start local feed server; check /tmp/freemid-feed-http.log" >&2
    exit 1
  fi
}

build_extension_with_overrides() {
  local latest_url releases_base
  latest_url="http://127.0.0.1:${PORT}/latest.json"
  releases_base="http://127.0.0.1:${PORT}"
  local windows_setup_url
  windows_setup_url="${FREEMID_WINDOWS_SETUP_URL:-}"

  if [[ ! -d "$EXT_DIR" ]]; then
    echo "Extension directory not found at ${EXT_DIR}" >&2
    exit 1
  fi

  echo "Building extension with local updater overrides..."
  (
    cd "$EXT_DIR"
    if [[ -n "$windows_setup_url" ]]; then
      VITE_UPDATE_LATEST_URL="$latest_url" \
      VITE_UPDATE_RELEASES_BASE="$releases_base" \
      VITE_MIN_SELF_UPDATE_HOST_VERSION="0.3.13" \
      VITE_WINDOWS_SETUP_URL="$windows_setup_url" \
      npm run build
    else
      VITE_UPDATE_LATEST_URL="$latest_url" \
      VITE_UPDATE_RELEASES_BASE="$releases_base" \
      VITE_MIN_SELF_UPDATE_HOST_VERSION="0.3.13" \
      npm run build
    fi
  )

  echo "Extension build complete with local updater feed URLs."
}

print_post_start() {
  local latest_url releases_base
  latest_url="http://127.0.0.1:${PORT}/latest.json"
  releases_base="http://127.0.0.1:${PORT}"

  echo
  echo "Local updater E2E lane is ready."
  echo "Latest URL: ${latest_url}"
  echo "Releases base URL: ${releases_base}"
  echo "Release tag served: ${release_tag}"
  echo
  echo "Reminder: install an older native host than ${workspace_version} before testing update"
  echo "or the popup will correctly show no update available."
  echo

  echo "Next steps:"
  echo "1. Reload unpacked extension in chrome://extensions"
  echo "2. Open popup and click Update on host row"
  echo "3. Verify status path: checking -> downloading -> success -> reconnect"
  echo
  echo "To stop server: ./scripts/local-update-e2e.sh stop"
}

case "$MODE" in
  stop)
    stop_server
    ;;
  status)
    status_server
    ;;
  start)
    prepare_feed
    start_server
    build_extension_with_overrides
    print_post_start
    ;;
esac
