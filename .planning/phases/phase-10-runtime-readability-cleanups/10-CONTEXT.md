# Phase 10: Runtime Readability Cleanups - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Apply low-risk cleanup items from the review report after Phase 9, while keeping the temporary verification-code flow unchanged.
</domain>

<decisions>
## Implementation Decisions

- Do not implement `CORR-002` or `CORR-004`.
- Keep behavior unchanged for routes and logs.
- Prefer narrow edits that reduce request-path object churn and make constants explicit.
- Use asynchronous file appends for runtime logs so console logging does not block request handling on disk I/O.
</decisions>

<code_context>
## Existing Code Insights

- Route modules destructure large scopes even when each route uses only a small subset.
- Auth registration and verification-code generation use inline numeric values.
- `appendRuntimeLog` writes synchronously on every console call.
</code_context>

<specifics>
## Specific Ideas

- Reduce route-scope destructuring in touched route modules to only the helpers each module uses.
- Extract auth constants for verification-code generation and initial credits.
- Change runtime log appends from `appendFileSync` to `appendFile`.
</specifics>

<deferred>
## Deferred Ideas

- Full helper module split.
- Full dependency injection for repositories.
- SMS gateway and verification-code validation.
</deferred>
