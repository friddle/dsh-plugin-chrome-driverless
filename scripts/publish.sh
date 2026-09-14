#!/usr/bin/env bash
#
# Publish this package to the public npm registry.
#
# The registry is pinned on purpose: a machine whose default registry is a
# read-only mirror fails `npm publish` with a confusing auth error, because it is
# the *mirror* rejecting the write.
#
# Usage:
#   npm login --registry https://registry.npmjs.org   # once per machine
#   scripts/publish.sh
#
# Tagging (vX.Y.Z) is a separate, deliberate step: it is what the GitHub release
# and the Release workflow key off.
#
set -euo pipefail

registry="${NPM_REGISTRY:-https://registry.npmjs.org}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"

echo "==> preflight: npm test"
npm test

echo "==> preflight: what would be published"
npm pack --dry-run 2>&1 | grep -E "package size|unpacked size|total files|npm notice.*lib/" || true

echo "==> auth"
npm whoami --registry "$registry"

echo "==> publishing $name@$version"
npm publish --registry "$registry" --access public

echo "==> verifying the registry sees it"
npm view "$name@$version" version --registry "$registry"
