#!/usr/bin/env bash
# RedBase production update pipeline (run on the server checkout, master only).
# Order is mandatory: clean tree -> pull master -> npm ci (backend + frontend)
# -> build into a temp dir with atomic swap -> full tests -> pm2 restart ->
# smoke checks. Any failure aborts BEFORE pm2 restart, so a broken build can
# never replace the running service or its current dist/public.
set -euo pipefail

APP_URL="${REDBASE_BASE_URL:-http://127.0.0.1:3013}"

echo "[deploy] 1/7 checking clean worktree"
if [ -n "$(git status --short)" ]; then
  echo "[deploy] worktree is not clean; aborting." >&2
  exit 1
fi

echo "[deploy] 2/7 switching to master and pulling"
git switch master
git pull --ff-only origin master

echo "[deploy] 3/7 installing locked dependencies (backend + frontend)"
npm ci
npm --prefix frontend ci

echo "[deploy] 4/7 building frontend (temp dir + atomic swap)"
# build-frontend.cjs stages into dist/.public-staging-* and only renames it
# over dist/public after typecheck, vite build, and entry checks all pass.
npm run build

echo "[deploy] 5/7 running full test suites"
npm run check
npm test
npm run test:integration
npm run test:frontend
npm run budget

echo "[deploy] 6/7 restarting service"
pm2 restart redbase

echo "[deploy] 7/7 smoke checks"
sleep 2
for path in /api/health / /app/ /admin/; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "${APP_URL}${path}")
  echo "[deploy] smoke ${path} -> ${code}"
  if [ "${code}" != "200" ]; then
    echo "[deploy] smoke check failed for ${path}; investigate immediately (previous build was already replaced only after all tests passed)." >&2
    exit 1
  fi
done

echo "[deploy] done"
