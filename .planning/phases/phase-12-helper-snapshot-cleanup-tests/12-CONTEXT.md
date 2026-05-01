# Phase 12: Helper Snapshot Cleanup And Tests - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Address the remaining third-review findings around helper size, snapshot-mode residue, duplicated auth helpers, and insufficient regression coverage.
</domain>

<decisions>
## Implementation Decisions

- Keep demo verification-code behavior unchanged.
- Remove helpers that only supported the old in-memory snapshot request path and are no longer called by routes.
- Split large helper responsibilities into smaller API helper modules while preserving the `bindRouteScope` facade for route compatibility.
- Add focused tests for security-sensitive and review-targeted behavior that can run without mutating the live SQLite database.
</decisions>

<code_context>
## Existing Code Insights

- Route modules now use SQL repositories directly.
- `health-routes.js` still destructures the full route scope despite only needing `appConfig` and `json`.
- `helpers.js` still exports old snapshot auth and mutation helpers that no active route calls.
- Existing tests are pure unit tests and do not require database mutation.
</code_context>

<specifics>
## Specific Ideas

- Split HTTP/logging helpers and content generation helpers out of `helpers.js`.
- Remove old snapshot auth helpers and unused snapshot mutation helpers.
- Trim health route destructuring.
- Add tests for signed URL validation, admin overview no-password mapping behavior, and route scope contents after cleanup.
</specifics>

<deferred>
## Deferred Ideas

- Full HTTP integration test harness with isolated temporary SQLite databases.
- Full removal of `snapshot-store.js` legacy migration/repair support.
</deferred>
