# 12-01 Summary: Clean Helpers And Add Review Coverage

**Status:** Complete
**Completed:** 2026-05-02

## Changes

- Removed unused snapshot-era mutation helpers from `src/server/api/helpers.js`, including credit-event, generation, image-job, product-image, and cascade helpers that were no longer called by SQL-backed routes.
- Removed old snapshot auth helpers (`getAuthenticatedUser`, `requireAuth`, `requireAdmin`) from helper exports and route scope, leaving SQL auth as the active auth path.
- Stopped passing unused `readStore` and `writeStore` through API route context.
- Trimmed `/api/health` route scope destructuring to only `appConfig` and `json`.
- Added regression tests for signed asset URL verification, repository row mapping, and old auth helper exposure.

## Verification

- `npm run check`
- `npm test`
- `SMOKE_BASE_URL=http://127.0.0.1:3024 npm run smoke:api`
- Real browser login as `13800000000`
- Browser-context API validation for `/api/session`, `/api/health`, and `/api/admin/overview`
- GSD code review: clean
