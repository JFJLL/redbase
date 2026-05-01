# Phase 15: Helper Facade Split - Context

**Gathered:** 2026-05-02
**Status:** Ready for planning

## Phase Boundary

Reduce the size and mixed responsibilities of `src/server/api/helpers.js` without changing route behavior.

## Decisions

- Keep `helpers.js` as a facade so existing `route-scope.js` and route modules remain compatible.
- Move cohesive helper groups into focused CommonJS modules.
- Update `npm run check` so new helper modules are included in syntax checks.
- Do not remove `route-scope.js` in this phase; doing that would be a larger import refactor.

## Verification Requirements

- `npm run check`
- `npm test`
- API smoke
- Real browser login
- Review
