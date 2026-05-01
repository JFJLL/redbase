# Phase 14: Automated Test Coverage - Context

**Gathered:** 2026-05-02
**Status:** Ready for planning

## Phase Boundary

Add automated tests around high-value server modules without refactoring runtime behavior.

## Decisions

- Prefer focused `node:test` files over broad E2E tests.
- Keep tests isolated with `REDBASE_DB_FILE=:memory:` so local data is not touched.
- Cover the most sensitive behavior first: credits, refunds, repository scoping, and history route auth/filtering.
- Do not add external test dependencies.

## Verification Requirements

- `npm run check`
- Direct Node execution for new and existing test files when sandbox blocks `npm test`
- API smoke
- Real browser login check after tests are added
- Code review
