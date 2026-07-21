#!/usr/bin/env bash

set -Eeuo pipefail

registry="${NPM_REGISTRY:-https://registry.redbtn.io}"
package_dir="${RELEASE_PACKAGE_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
allow_new_package="${ALLOW_NEW_PACKAGE:-false}"
dry_run="${RELEASE_DRY_RUN:-false}"

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [--allow-new-package] [--dry-run] [--registry URL]

Reads the package name and version from package.json, publishes a missing
version, and reconciles the latest (and prerelease alpha) dist-tags.
EOF
}

die() {
  printf 'release: ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf 'release: %s\n' "$*"
}

is_true() {
  case "${1,,}" in
    1|true|yes|y) return 0 ;;
    *) return 1 ;;
  esac
}

while (($#)); do
  case "$1" in
    --allow-new-package)
      allow_new_package=true
      ;;
    --dry-run)
      dry_run=true
      ;;
    --registry)
      (($# >= 2)) || die "--registry requires a URL"
      registry="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
  shift
done

command -v npm >/dev/null 2>&1 || die "npm is required"
command -v node >/dev/null 2>&1 || die "node is required"

package_json="${RELEASE_PACKAGE_JSON:-$package_dir/package.json}"
[[ -f "$package_json" ]] || die "package.json not found: $package_json"

metadata="$(node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof pkg.name !== "string" || !pkg.name) throw new Error("package.json has no name");
  if (typeof pkg.version !== "string" || !pkg.version) throw new Error("package.json has no version");
  process.stdout.write(`${pkg.name}\t${pkg.version}`);
' "$package_json")" || die "could not read package metadata"
IFS=$'\t' read -r package_name package_version <<< "$metadata"
[[ -n "$package_name" && -n "$package_version" ]] || die "package name/version are required"

log "checking $package_name@$package_version at $registry"
query_error="$(mktemp)"
trap 'rm -f "$query_error"' EXIT
if versions_json="$(npm view "$package_name" versions --json --registry "$registry" 2>"$query_error")"; then
  registry_has_package=true
else
  if grep -qE 'E404|404 Not Found|is not in this registry' "$query_error"; then
    registry_has_package=false
    versions_json='[]'
  else
    cat "$query_error" >&2
    die "registry query failed"
  fi
fi

if [[ "$registry_has_package" == false ]]; then
  if ! is_true "$allow_new_package"; then
    die "$package_name has no registry entry; rerun workflow_dispatch with allow_new_package=true to create it"
  fi
  log "$package_name has no registry entry; explicit allow_new_package is set"
fi

if [[ "$registry_has_package" == true ]] && printf '%s' "$versions_json" | node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(0, "utf8"));
  const versions = Array.isArray(value) ? value : [value];
  process.exit(versions.includes(process.argv[1]) ? 0 : 1);
' "$package_version"; then
  log "$package_name@$package_version is already published; skipping npm publish"
else
  log "$package_name@$package_version is not published; selecting npm publish"
  publish_args=(publish --registry "$registry")
  if [[ "$package_version" == *-* ]]; then
    publish_args+=(--tag alpha)
  fi
  if is_true "$dry_run"; then
    publish_args+=(--dry-run)
  fi
  (
    cd "$package_dir"
    npm "${publish_args[@]}"
  )
fi

reconcile_tag() {
  local tag="$1"
  if is_true "$dry_run"; then
    log "[dry-run] npm dist-tag add $package_name@$package_version $tag --registry $registry"
  else
    npm dist-tag add "$package_name@$package_version" "$tag" --registry "$registry"
  fi
}

reconcile_tag latest
if [[ "$package_version" == *-* ]]; then
  reconcile_tag alpha
fi

log "release completed for $package_name@$package_version"
