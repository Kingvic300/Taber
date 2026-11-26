#!/usr/bin/env bash
# Submit Taber to addons.mozilla.org as a public (listed) add-on.
# Needs AMO API keys: https://addons.mozilla.org/developers/addon/api/key/
#   export AMO_JWT_ISSUER=user:12345:678
#   export AMO_JWT_SECRET=...
set -euo pipefail
cd "$(dirname "$0")"
# Keys can live in .amo.env (gitignored).
if [ -f .amo.env ]; then set -a; . ./.amo.env; set +a; fi
: "${AMO_JWT_ISSUER:?set AMO_JWT_ISSUER}"
: "${AMO_JWT_SECRET:?set AMO_JWT_SECRET}"
npx -y web-ext@8 lint --source-dir . --ignore-files dist tools '*.sh' '*.md' amo-metadata.json .amo.env public
npx -y web-ext@8 sign \
  --source-dir . \
  --ignore-files dist tools '*.sh' '*.md' amo-metadata.json .amo.env public \
  --channel listed \
  --amo-metadata amo-metadata.json \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET" \
  --artifacts-dir dist
