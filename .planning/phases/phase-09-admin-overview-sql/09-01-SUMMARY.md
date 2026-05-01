# 09-01 Summary: Move Admin Overview To SQL Repositories

**Status:** Complete
**Completed:** 2026-05-01

## Changes

- Added SQL-backed listing helpers for all users, brands, generations, and credit events.
- Added `readAdminOverviewStore()` to assemble only the admin overview data needed by `buildAdminOverview`.
- Replaced admin overview refreshes in `admin-routes.js` so `/api/admin/overview`, add-credit responses, user deletion responses, and generation deletion responses no longer call `readStore()`.

## Verification

- [x] `npm run check`
- [x] `npm test`
- [x] `SMOKE_BASE_URL=http://127.0.0.1:3024 npm run smoke:api`
- [x] Playwright real browser login at `http://127.0.0.1:3024`
- [x] Browser-context `/api/session` returned `200`
- [x] Browser-context `/api/admin/overview` returned `200`

## Residual Risk

- `snapshot-store.js` remains for initialization, legacy migration, and repair compatibility.
- This phase does not change the temporary demo verification-code flow.
