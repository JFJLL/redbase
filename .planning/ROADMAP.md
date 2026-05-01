# Redbase Refactor Roadmap

**Created:** 2026-04-30  
**Current phase:** 13
**Overall status:** History generation search and filters complete

## Progress Summary

| Phase | Name | Status | Plans |
| --- | --- | --- | --- |
| 1 | Module Boundaries | Complete | 3/3 |
| 2 | Runtime Security Quick Wins | Complete | 3/3 |
| 3 | Auth And Protected Assets | Complete | 3/3 |
| 4 | Granular SQL Data Access | Complete | 4/4 |
| 5 | Frontend Split And Layout | Complete | 2/2 |
| 6 | Hardening, Docs, Release Readiness | Complete | 2/2 |
| 7 | Review Hardening Quick Wins | Complete | 1/1 |
| 8 | Review Regression Tests | Complete | 1/1 |
| 9 | Admin Overview SQL | Complete | 1/1 |
| 10 | Runtime Readability Cleanups | Complete | 1/1 |
| 11 | Admin Overview Hardening | Complete | 1/1 |
| 12 | Helper Snapshot Cleanup And Tests | Complete | 1/1 |
| 13 | History Generation Search | Complete | 1/1 |

## Phase 1: Module Boundaries

**Goal:** Split oversized server files into domain modules while preserving behavior.

**Directory:** `.planning/phases/phase-01-module-boundaries/`

**Plans:**
- [x] `01-01-PLAN.md` - Split API routing and shared HTTP helpers
- [x] `01-02-PLAN.md` - Split AI provider/prompt/image-job modules
- [x] `01-03-PLAN.md` - Split store schema/migration/legacy hydration boundaries

**Exit criteria:**
- [x] `npm run check` passes.
- [x] Existing route behavior remains compatible.
- [x] `src/server/api.js`, `src/server/ai.js`, and `src/server/store.js` become orchestration/facade modules or shrink substantially.

## Phase 2: Runtime Security Quick Wins

**Goal:** Apply low-risk security and performance fixes that do not require auth/data-model migration.

**Directory:** `.planning/phases/phase-02-runtime-security-quick-wins/`

**Plans:**
- [x] `02-01-PLAN.md` - Move secrets/config docs to environment variables
- [x] `02-02-PLAN.md` - Add CORS/preflight middleware and safer client errors
- [x] `02-03-PLAN.md` - Replace Gemini Python subprocess with native fetch

**Exit criteria:**
- [x] `npm run check` passes.
- [x] No tracked file contains real API keys.
- [x] CORS can be configured through env.
- [x] Gemini calls no longer spawn Python.

## Phase 3: Auth And Protected Assets

**Goal:** Remove plaintext passwords and URL-exposed session tokens.

**Directory:** `.planning/phases/phase-03-auth-and-protected-assets/`

**Plans:**
- [x] `03-01-PLAN.md` - Add scrypt password hashing and legacy migration
- [x] `03-02-PLAN.md` - Move browser sessions to HttpOnly cookies
- [x] `03-03-PLAN.md` - Add signed URLs for protected images/assets

**Exit criteria:**
- [x] Plaintext password storage is removed for new writes.
- [x] Normal API calls authenticate through cookies.
- [x] Image URLs no longer contain session tokens.
- [x] Login regression hotfix verified with a full browser login pass.

**Hotfixes:**
- `03-HOTFIX-LOGIN-REGRESSION.md` - Prevent failed post-login data loads from advancing to a dashboard with cleared user state.

## Phase 4: Granular SQL Data Access

**Goal:** Replace full-store request read/write with direct SQL repository operations.

**Directory:** `.planning/phases/phase-04-granular-sql-data-access/`

**Plans:**
- [x] `04-01-PLAN.md` - Add DB connection/repository foundation
- [x] `04-02-PLAN.md` - Move auth/admin/credits routes to SQL repositories
- [x] `04-03-PLAN.md` - Move brands/trends/generations routes to SQL repositories
- [x] `04-04-PLAN.md` - Move images/jobs/file metadata routes to SQL repositories and retire request-path snapshots

**Exit criteria:**
- Request handlers no longer call full `readStore()`/`writeStore()` for normal CRUD mutations.
- Multi-table writes are transactional.
- Legacy snapshot helpers remain only for migration/admin compatibility if still needed.

## Phase 5: Frontend Split And Layout

**Goal:** Split the frontend controller and normalize card layout behavior.

**Directory:** `.planning/phases/phase-05-frontend-split-and-layout/`

**Plans:**
- [x] `05-01-PLAN.md` - Split `public/app.js` into feature modules
- [x] `05-02-PLAN.md` - Normalize brand archive/history card dimensions and overflow behavior

**Exit criteria:**
- `npm run check` passes for split frontend files.
- Brand profile and history generation cards stay balanced with long content.

## Phase 6: Hardening, Docs, Release Readiness

**Goal:** Close refactor residue, update docs, and produce release-ready verification notes.

**Directory:** `.planning/phases/phase-06-hardening-docs-release/`

**Plans:**
- [x] `06-01-PLAN.md` - Add smoke-test scripts/checklists and cleanup legacy compatibility
- [x] `06-02-PLAN.md` - Update README/product docs/deployment docs for new architecture and envs

**Exit criteria:**
- Docs match the implemented runtime behavior.
- A fresh local setup can follow docs without real secrets in files.
- Final verification and UAT are recorded.

## Phase 7: Review Hardening Quick Wins

**Goal:** Address actionable post-review correctness/security findings without changing the temporary demo verification-code flow.

**Directory:** `.planning/phases/phase-07-review-hardening-quick-wins/`

**Plans:**
- [x] `07-01-PLAN.md` - Apply low-risk review hardening fixes

**Exit criteria:**
- [x] Failed image jobs refund already-charged credits once.
- [x] Production session cookies can be marked `Secure` through configuration.
- [x] Default OpenAI/Anthropic compatible URLs no longer expose hardcoded infrastructure.
- [x] Admin access requires configured admin phones.
- [x] Trend lookup only accepts normalized bucket item structures.
- [x] Route scope binding avoids per-request merge churn.
- [x] `npm run check`, API smoke, and real browser login pass.

## Backlog

## Phase 9: Admin Overview SQL

**Goal:** Move the remaining admin overview request path off full snapshot-store reads.

**Directory:** `.planning/phases/phase-09-admin-overview-sql/`

**Plans:**
- [x] `09-01-PLAN.md` - Move admin overview to SQL repositories

**Exit criteria:**
- [x] `/api/admin/overview` does not call `readStore()`.
- [x] `npm run check`, `npm test`, API smoke, and real browser login pass.

## Phase 10: Runtime Readability Cleanups

**Goal:** Apply low-risk readability and runtime cleanup items from the follow-up review.

**Directory:** `.planning/phases/phase-10-runtime-readability-cleanups/`

**Plans:**
- [x] `10-01-PLAN.md` - Runtime and route readability cleanups

**Exit criteria:**
- [x] Reviewed route modules only destructure helpers they use.
- [x] Verification-code magic numbers and registration initial credits are named constants.
- [x] Runtime logs use asynchronous file appends.
- [x] `npm run check`, `npm test`, API smoke, and real browser login pass.

## Phase 11: Admin Overview Hardening

**Goal:** Address admin overview security/performance and repository mapping findings from the third review report.

**Directory:** `.planning/phases/phase-11-admin-overview-hardening/`

**Plans:**
- [x] `11-01-PLAN.md` - Harden admin overview data access

**Exit criteria:**
- [x] Admin overview does not query password hashes.
- [x] Admin overview uses aggregate SQL plus bounded detail rows instead of loading all detail records.
- [x] Brand/generation row mapping is centralized in `row-mappers.js`.
- [x] Brand deletion is transactional.
- [x] Admin user deletion removes stored files before SQL row deletion.
- [x] `npm run check`, `npm test`, API smoke, real browser login, and GSD code review pass.

## Phase 12: Helper Snapshot Cleanup And Tests

**Goal:** Remove unused snapshot-era helper exports and add focused regression coverage for the remaining third-review findings.

**Directory:** `.planning/phases/phase-12-helper-snapshot-cleanup-tests/`

**Plans:**
- [x] `12-01-PLAN.md` - Clean helpers and add review coverage

**Exit criteria:**
- [x] Snapshot-era mutation/auth helpers are no longer exported from `helpers.js` or route scope.
- [x] API route context no longer passes unused `readStore`/`writeStore`.
- [x] Health route only destructures the helpers it uses.
- [x] Tests cover signed asset verification, row mapper conversion, and old auth helper exposure.
- [x] `npm run check`, `npm test`, API smoke, real browser login/API validation, and GSD code review pass.

## Phase 13: History Generation Search

**Goal:** Add searchable, filterable history generation browsing without changing generation creation or asset access behavior.

**Directory:** `.planning/phases/phase-13-history-generation-search/`

**Plans:**
- [x] `13-01-PLAN.md` - Add history search and filters

**Exit criteria:**
- [x] `/api/history?q=...` searches card title, summary, trend title, idea title, and brand name.
- [x] `/api/history?brandId=...`, `/api/history?type=...`, and date range filters narrow results through SQL.
- [x] History page filters reload the list without requiring a full page refresh.
- [x] Empty filters preserve the original unfiltered history behavior.
- [x] `npm run check`, focused tests, API smoke, real browser login/API validation, and GSD code review pass.

## Phase 8: Review Regression Tests

**Goal:** Add focused automated regression coverage for the post-review hardening behavior.

**Directory:** `.planning/phases/phase-08-review-regression-tests/`

**Plans:**
- [x] `08-01-PLAN.md` - Add review regression tests

**Exit criteria:**
- [x] `npm test` covers core Phase 7 hardening behavior.
- [x] `npm test`, `npm run check`, API smoke, and real browser login pass.

- Add automated integration tests for auth/session/image signing once route modules stabilize.
- Add rate limiting for auth endpoints.
- Add database backup/restore workflow for production data.
