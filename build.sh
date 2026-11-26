#!/usr/bin/env bash
# Package Tabora for Chrome and Firefox. Same source, one manifest.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')
mkdir -p dist
rm -f "dist/tabora-$VERSION-chrome.zip" "dist/tabora-$VERSION-firefox.xpi"
zip -qr "dist/tabora-$VERSION-chrome.zip" manifest.json src icons
cp "dist/tabora-$VERSION-chrome.zip" "dist/tabora-$VERSION-firefox.xpi"
echo "Built dist/tabora-$VERSION-chrome.zip and dist/tabora-$VERSION-firefox.xpi"
