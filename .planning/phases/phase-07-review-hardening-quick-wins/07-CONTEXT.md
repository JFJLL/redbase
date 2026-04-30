# Phase 7: Review Hardening Quick Wins - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Apply the review findings that are safe for the current testing-stage product. Do not enforce SMS verification or remove the demo verification code response in this phase.
</domain>

<decisions>
## Implementation Decisions

- Keep the temporary verification-code response and registration behavior unchanged.
- Prefer small, repository-backed fixes over broad rewrites.
- Keep all changes dependency-free.
- Verify with syntax checks, API smoke coverage, and a real browser login pass before commit.
</decisions>

<code_context>
## Existing Code Insights

- Image generation routes create image jobs, deduct credits immediately, then persist job completion during polling.
- Credit events are stored through `admin-repository.js`; user credits are updated through `auth-repository.js`.
- Session cookies are centralized in `src/server/auth/cookies.js`.
- App configuration is centralized in `src/server/config.js`.
- Admin permission checks are implemented in `src/server/api/helpers.js`.
- Route modules call `bindRouteScope(context)` on request paths.
</code_context>

<specifics>
## Specific Ideas

- Add an idempotent refund path for failed image jobs tied to an existing negative credit event.
- Add `security.cookieSecure` config controlled by `COOKIE_SECURE` or production defaults.
- Remove hardcoded default compatible provider URLs.
- Make admin access depend on `ADMIN_PHONES` / configured admin phone list only.
- Remove the flat trend fallback from `findTrendItem`.
- Cache route scope bindings by context object.
</specifics>

<deferred>
## Deferred Ideas

- Full SMS gateway validation remains deferred by user request.
- Broader helpers.js decomposition remains a later architecture phase.
- Repository migration for every remaining snapshot compatibility path remains a later phase.
</deferred>
