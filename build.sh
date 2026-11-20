#!/usr/bin/env bash
# Package Taber for Chrome and Firefox. Same source, one manifest.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
mkdir -p dist
rm -f "dist/taber-$VERSION-chrome.zip" "dist/taber-$VERSION-firefox.xpi"
zip -qr "dist/taber-$VERSION-chrome.zip" manifest.json src icons
cp "dist/taber-$VERSION-chrome.zip" "dist/taber-$VERSION-firefox.xpi"
echo "Built dist/taber-$VERSION-chrome.zip and dist/taber-$VERSION-firefox.xpi"
