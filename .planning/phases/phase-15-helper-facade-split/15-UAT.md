# Phase 15 UAT

## Browser Validation

**Date:** 2026-05-02

**Environment:** Temporary local service on `http://127.0.0.1:3014` from current working tree.

**Flow:**

1. Opened RedBase in Chromium.
2. Used the login modal and authenticated with the smoke-test account.
3. Waited for the dashboard.

**Result:** Passed.

**Observed:** Dashboard was active, user name rendered as `Test User`, and the default active tab was `brands`.

## API Validation

**Command:** `npm run smoke:api` with `SMOKE_BASE_URL=http://127.0.0.1:3014`

**Result:** Passed.
