# Phase 11: Admin Overview Hardening - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Address the third review report's admin overview security/performance and repository mapping concerns.
</domain>

<decisions>
## Implementation Decisions

- Keep demo verification-code behavior unchanged.
- Replace admin overview full-row loading with aggregate SQL plus bounded detail queries.
- Keep the existing admin response shape so the frontend does not need a large rewrite.
- Centralize brand and generation row mapping in `row-mappers.js`.
- Include the adjacent brand-delete transaction hardening because it is low risk and review-relevant.
</decisions>

<code_context>
## Existing Code Insights

- `readAdminOverviewStore()` currently loads all users, hydrated brands, generations, and credit events.
- `buildAdminOverview()` can keep rendering the same response if supplied precomputed stats and user metrics.
- Brand and generation repositories currently define local row mappers.
</code_context>

<specifics>
## Specific Ideas

- Remove `password` from admin overview user queries.
- Add aggregate SQL for overview stats and per-user metrics.
- Limit user, brand, generation, and usage-event detail rows.
- Avoid hydrating brand trend ideas for the admin overview archive list.
- Move mapper functions into `row-mappers.js`.
</specifics>

<deferred>
## Deferred Ideas

- Full admin pagination UI.
- Full deletion of snapshot-store migration compatibility.
</deferred>
