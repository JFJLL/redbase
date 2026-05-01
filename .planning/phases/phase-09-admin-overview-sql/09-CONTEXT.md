# Phase 9: Admin Overview SQL - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Reduce the remaining request-path snapshot-store usage called out by the follow-up review, without changing the temporary SMS/demo verification-code flow.
</domain>

<decisions>
## Implementation Decisions

- Keep `CORR-002` and `CORR-004` out of scope per user direction.
- Target the highest-value snapshot-store request path first: `/api/admin/overview`.
- Preserve the existing admin response shape by feeding `buildAdminOverview` a SQL-backed store-shaped object.
- Avoid broad snapshot-store removal in this phase because migration and legacy repair paths still rely on it.
</decisions>

<code_context>
## Existing Code Insights

- `admin-routes.js` called `readStore()` before building the overview.
- Repository modules already expose SQL access for users, brands, generations, and credit events.
- `buildAdminOverview` works from arrays and can be reused if those arrays are SQL-backed.
</code_context>

<specifics>
## Specific Ideas

- Add SQL list helpers for all brands and all generations.
- Add an admin repository helper that returns only the data required by `buildAdminOverview`.
- Replace admin overview refreshes after add credits/delete operations with the SQL-backed helper.
</specifics>

<deferred>
## Deferred Ideas

- Full deletion of `readStore()`/`writeStore()`.
- Trend route persistence redesign beyond the repository-based flow already in place.
</deferred>
