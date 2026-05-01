# 11-01 Summary: Harden Admin Overview Data Access

**Status:** Complete
**Completed:** 2026-05-02

## Changes

- Removed password selection from admin overview user queries.
- Replaced admin overview full-detail loading with aggregate SQL plus bounded detail queries.
- Kept admin response compatibility while allowing precomputed stats, user metrics, and brand views.
- Centralized brand and generation row mappers in `row-mappers.js`.
- Wrapped `deleteBrandById` in a transaction.
- Restored admin user deletion asset cleanup before SQL row deletion for brand logos, generated images, and product images.

## Verification

- [x] `npm run check`
- [x] `npm test`
- [x] `SMOKE_BASE_URL=http://127.0.0.1:3024 npm run smoke:api`
- [x] Playwright real browser login at `http://127.0.0.1:3024`
- [x] Browser-context `/api/session` returned `200`
- [x] Browser-context `/api/admin/overview` returned `200`
- [x] Browser-context `/api/admin/overview` response did not contain `password`
- [x] GSD code review rerun: `status: clean`

## Review

- Initial review found 2 warnings: `generationTokens` response semantics and user deletion file cleanup.
- Both warnings were fixed and the GSD re-review reported zero findings.
