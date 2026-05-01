# Summary 14-01: Add Focused Automated Coverage

## Completed

- Added `tests/credits/credit-system.test.js` with 6 credit/accounting tests.
- Added `tests/repositories/repository-core.test.js` covering counters, brand repository behavior, and generation repository behavior.
- Added `tests/api/history-routes.test.js` covering history route authentication, unfiltered responses, and filtered responses.
- Kept all new database tests isolated with `REDBASE_DB_FILE=:memory:`.

## Verification

- `npm run check` passed.
- `npm test` passed in sandbox-escalated mode with 23/23 tests passing.
- Direct Node execution of each test file passed.
- API smoke passed against a temporary 3014 service from the current working tree.
- Real Chromium login passed against the same temporary 3014 service.
