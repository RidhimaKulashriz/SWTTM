#!/usr/bin/env bash
# Runs every verification gate. Exits non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."
npx next typegen
npm exec tsc -- --noEmit --pretty false
npx vitest run
npm run build
./scripts/restart-server.sh
npx playwright test
echo "ALL GATES GREEN"
