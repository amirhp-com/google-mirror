#!/bin/bash
# Usage: ./bump-version.sh <major|minor|patch>
# Bumps version across all files

set -e

FILES=(
  "js/app.js"
  "api/proxy.js"
  "worker/proxy-worker.js"
)

# Get current version from app.js
CURRENT=$(grep -oE "VERSION = '[0-9]+\.[0-9]+\.[0-9]+" js/app.js | grep -oE "[0-9]+\.[0-9]+\.[0-9]+")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "${1:-patch}" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch)
    PATCH=$((PATCH + 1))
    if [ "$PATCH" -ge 10 ]; then
      PATCH=0
      MINOR=$((MINOR + 1))
    fi
    ;;
  *) echo "Usage: $0 <major|minor|patch>"; exit 1 ;;
esac

NEW="$MAJOR.$MINOR.$PATCH"

echo "Bumping version: $CURRENT -> $NEW"

for f in "${FILES[@]}"; do
  sed -i '' "s/$CURRENT/$NEW/g" "$f"
  echo "  Updated $f"
done

echo "Done! Version is now $NEW"
