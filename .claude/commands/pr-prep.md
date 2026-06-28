# PR Prep

Run all checks that the CI pipeline runs, in the same order, and report any failures. Fix auto-fixable issues (cargo fmt, biome --write) before reporting.

## Steps

### 1. Version consistency
```bash
bash scripts/sync-version.sh --check
```

### 2. Installer default extension ID consistency
```bash
sh_id=$(sed -n 's/^DEFAULT_EXTENSION_ID="\([a-z0-9]\+\)"$/\1/p' install/install.sh)
ps_id=$(sed -n 's/^\$DefaultExtensionId = "\([a-z0-9]\+\)"$/\1/p' install/install.ps1)
rs_id=$(sed -n 's/^    const DEFAULT_EXTENSION_ID: &str = "\([a-z0-9]\+\)";$/\1/p' installer/src/main.rs)
if [[ "$sh_id" != "$ps_id" || "$sh_id" != "$rs_id" ]]; then
  echo "FAIL: installer default extension IDs are inconsistent"
  echo "install.sh: $sh_id  install.ps1: $ps_id  installer/src/main.rs: $rs_id"
else
  echo "OK: extension ID consistent ($sh_id)"
fi
```

### 3. Extension checks (run from `extension/`)
```bash
npm audit --audit-level=high
npm run lint:fix          # auto-fix biome issues first
npm run lint              # then verify clean
npm run typecheck
npm run test:run
npm run build
```

### 4. Native host checks (run from repo root)
```bash
cargo fmt                 # auto-fix formatting first
cargo fmt --check         # then verify clean
cargo clippy -- -D warnings
cargo test
```

## How to run

Execute each step with `rtk` prefix. Collect all failures and report them together at the end. If `cargo fmt` or `biome lint:fix` modifies files, stage them before committing.

## What CI does NOT check locally

- `npm audit` — may flag advisories not present in CI's pinned environment; treat high+ severity as blocking.
- Windows-only compilation (`windows-artifacts.yml`) — not runnable on Linux; only matters if Rust changes touch `#[cfg(windows)]` code.
