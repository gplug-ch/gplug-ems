#!/usr/bin/env bash
# Publish the built frontend bundle to the gplug-cdn repo (GitHub Pages).
#
# Copies dist/<version>/ into a fresh clone of gplug-ch/gplug-cdn as
# /<version>/ and pushes to main; the repo's deploy-pages.yml workflow then
# publishes it at https://gplug-ch.github.io/gplug-cdn/<version>/.
# Existing version directories in the repo are left untouched so devices
# flashed with older .tapps keep resolving their assets.
#
# Version resolution matches vite.config.js: APP_VERSION env var, else
# ../backend/VERSION.txt. Override the target repo with CDN_REPO.
set -euo pipefail

FRONTEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CDN_REPO="${CDN_REPO:-https://github.com/gplug-ch/gplug-cdn.git}"

VERSION="${APP_VERSION:-v$(tr -d '[:space:]' < "$FRONTEND_DIR/../backend/VERSION.txt")}"
SRC="$FRONTEND_DIR/dist/$VERSION"
if [ ! -d "$SRC" ]; then
  echo "error: $SRC not found — run 'npm run build' first" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone --quiet --depth 1 "$CDN_REPO" "$TMP/cdn"

# JS/CSS bundle + lang.json go to the CDN; the index.html shell ships inside
# the .tapp, never from the CDN.
rsync -a --delete --exclude='index.html' "$SRC/" "$TMP/cdn/$VERSION/"

cd "$TMP/cdn"
git add -A -- "$VERSION"
if git diff --cached --quiet; then
  echo "CDN already up to date for $VERSION"
  exit 0
fi
git commit --quiet -m "publish $VERSION"
git push --quiet
echo "published $VERSION -> https://gplug-ch.github.io/gplug-cdn/$VERSION/"
