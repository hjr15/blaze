#!/usr/bin/env bash
# scripts/ci/smoke.sh — package smoke gate. Hermetic: packs the current
# package into a tarball, installs the TARBALL (not the repo checkout) into
# a clean throwaway project, builds a minimal fixture data repo, and boots
# the INSTALLED `blaze` bin against it. Fails loud if the published package
# can't actually run — catches missing package.json#files/#bin entries that
# `npm test` against the repo checkout would never surface.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# 1. pack the current package
TARBALL="$(cd "$ROOT" && npm pack --silent --pack-destination "$WORK")"

# 2. install the tarball into a clean project (no repo node_modules)
mkdir -p "$WORK/app" && cd "$WORK/app"
npm init -y >/dev/null
npm install --silent "$WORK/$TARBALL"

# 3. a minimal fresh fixture data repo
mkdir -p data/projects/OBA/defined
printf '{"key":"OBA","projects":["OBA"],"commitMode":"batch"}\n' > data/blaze.config.json
printf -- '---\nid: OBA-1\ntitle: smoke\ntype: task\nproject: OBA\npriority: medium\nestimate: 30\n---\n\nbody\n' > data/projects/OBA/defined/OBA-1.md

# 4. boot the INSTALLED bin against the fixture and assert a real success signal
OUT="$(BLAZE_PROJECTS_DIR="$WORK/app/data/projects" BLAZE_DB_DIR="$WORK/app/data/.blaze" npx --no-install blaze reindex 2>&1)"
echo "$OUT"
echo "$OUT" | grep -q "indexed 1 ticket" || { echo "SMOKE FAIL: reindex did not index the fixture"; exit 1; }
echo "SMOKE OK"
