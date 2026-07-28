#!/usr/bin/env bash
# RedBase production update pipeline (run on the server checkout, master only).
# Order is mandatory:
#   clean tree -> pull master -> npm ci (backend + frontend)
#   -> build a candidate directory (dist/public untouched)
#   -> asset budget on the candidate -> full test suites
#   -> promote candidate (previous build kept at dist/.public-previous)
#   -> pm2 restart -> smoke checks on /api/health, /, /app/, /admin/.
# Any test/budget failure happens BEFORE promotion, so dist/public is never
# modified by a failing run. If the post-restart smoke checks fail, the
# previous build is rolled back automatically, the service is restarted on
# it, re-smoked, and the script exits non-zero.
set -euo pipefail

APP_URL="${REDBASE_BASE_URL:-http://127.0.0.1:3013}"
CANDIDATE_DIR="dist/.public-candidate-$$"
BACKUP_DIR="dist/.public-previous"
PROMOTED=0

cleanup() {
  # Remove an unpromoted candidate on any exit; after promotion the candidate
  # directory no longer exists (it was renamed to dist/public).
  if [ "${PROMOTED}" -eq 0 ] && [ -d "${CANDIDATE_DIR}" ]; then
    rm -rf "${CANDIDATE_DIR}"
  fi
}
trap cleanup EXIT

smoke_all() {
  local failed=0 path code
  for path in /api/health / /app/ /admin/; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "${APP_URL}${path}")
    echo "[deploy] smoke ${path} -> ${code}"
    if [ "${code}" != "200" ]; then
      failed=1
    fi
  done
  return "${failed}"
}

echo "[deploy] 1/9 checking clean worktree, switching to master"
if [ -n "$(git status --short)" ]; then
  echo "[deploy] worktree is not clean; aborting." >&2
  exit 1
fi
git switch master
# OLD_SHA is captured BEFORE pulling: a failed smoke check rolls sources,
# dependencies and frontend artifacts all back to this commit together.
OLD_SHA="$(git rev-parse HEAD)"
echo "[deploy] OLD_SHA=${OLD_SHA}"
git pull --ff-only origin master

echo "[deploy] 2/9 installing locked dependencies (backend + frontend)"
npm ci
npm --prefix frontend ci

echo "[deploy] 3/9 building release candidate into ${CANDIDATE_DIR}"
# typecheck + vite build + three-entry check + legacy asset merge; stops at
# the candidate directory without touching dist/public.
node scripts/build-frontend.cjs --stage-dir "${CANDIDATE_DIR}"

echo "[deploy] 4/9 asset budget on the candidate"
node scripts/check-asset-budget.cjs --dir "${CANDIDATE_DIR}"

echo "[deploy] 5/9 full test suites (dist/public still untouched)"
npm run check
npm test
npm run test:integration
npm run test:frontend

echo "[deploy] 6/9 promoting candidate (previous build saved at ${BACKUP_DIR})"
node scripts/build-frontend.cjs --promote "${CANDIDATE_DIR}"
PROMOTED=1

echo "[deploy] 7/9 restarting service"
pm2 restart redbase

echo "[deploy] 8/9 smoke checks"
sleep 2
if smoke_all; then
  echo "[deploy] done"
  exit 0
fi

echo "[deploy] 9/9 smoke checks failed — full rollback to OLD_SHA ${OLD_SHA}" >&2
# Full rollback: frontend artifacts (backup, or legacy public/ on a first
# deploy without dist backup) + server sources at OLD_SHA + old dependencies
# + pm2 restart + re-smoke of the OLD version. Rolling back only the frontend
# while the new backend keeps running is forbidden.
node scripts/deploy-rollback.cjs --old-sha "${OLD_SHA}" --backup "${BACKUP_DIR}" --app-url "${APP_URL}" && ROLLBACK_STATUS=0 || ROLLBACK_STATUS=$?
if [ "${ROLLBACK_STATUS}" -eq 0 ]; then
  echo "[deploy] rollback verified healthy on the old version; the new build was rejected. Investigate before redeploying." >&2
else
  echo "[deploy] rollback completed but the old version smoke checks are STILL failing; manual intervention required." >&2
fi
exit 1
