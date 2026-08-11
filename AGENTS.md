# RedBase project rules

## Project

- Goal: run a local/hosted Xiaohongshu content-operations product with real trend evidence, AI generation, image generation, authentication, and SQLite persistence.
- Runtime: Node.js server with static frontend assets; there is no compile/bundle step.
- Main directories: `src/server/` backend, `public/` frontend, `tests/` deterministic tests, `scripts/` operational checks, `data/` local runtime state.

## Commands

```powershell
npm start
npm run check
npm test
npm run test:integration
npm run eval:ai
npm run smoke:api
```

## Security and temporary files

- Keep API keys, cookies, tokens, passwords, customer data, and local database contents out of source, examples, logs, test fixtures, and commits.
- Real secrets belong in environment variables or ignored `config.local.json`; `config.local.example.json` contains placeholders only.
- Disposable benchmark output belongs in ignored `outputs/`; verification receipts belong in ignored `.verification/` and `artifacts/verification/`.
- Preserve unrelated worktree changes. Do not commit, push, deploy, or enable hooks/CI without explicit user instruction.

## Branch and server deployment

- `master` is the canonical production branch. New feature branches must start from an up-to-date `master`.
- The production checkout at `/home/red/work/moneyboost/redbase` must remain on `master`; do not deploy feature, rescue, or UI experiment branches.
- The server deploy key is intentionally read-only. Push commits from an authorized local development machine, never from the server.
- Before a server update, require a clean `git status --short`, then use `git switch master`, `git pull --ff-only origin master`, and `pm2 restart redbase`.
- Do not use force-push, destructive reset, or branch rewriting as part of the deployment flow.

## Verification contract

- `verification-policy.json` is the risk-routing authority; `scripts/verify-change.ps1` is the deterministic execution authority.
- Change scope is merge-base against `changeScope.baseRef` (origin/master); uncommitted, committed, deleted, renamed, and untracked files all count.
- After any runtime behavior change, run `$verify-change` or `pwsh -NoProfile -File scripts/verify-change.ps1`.
- Completion requires `.verification/receipt.json` with `schemaVersion: 2`, `status: pass`, and a `changeSetHash` matching the current change set (policy hash, runner hash, and evidence artifact hashes are bound to the receipt).
- Do not skip failing tests, weaken assertions, hand-edit the receipt, or fabricate evidence.
- Risk can only escalate: `-RiskFloor` may raise the computed risk, never lower it.
- `agent-review` runs only when the plan requires it. Reviewers must be fresh-context and read-only; high/critical findings must be resolved before pass.
- Kimi WebBridge is the browser acceptance gate. Reproducible defects become unit/API/domain/data regressions when practical; UI-only defects become named reusable Kimi cases.
- When WebBridge is unavailable, record the lane as blocked and keep verification failed.
- R3 work includes production-like smoke and rollback/recovery checks before release.

### Canonical commands

```powershell
pwsh -NoProfile -File scripts/verify-change.ps1 -PlanOnly
pwsh -NoProfile -File scripts/verify-change.ps1
pwsh -NoProfile -File scripts/verify-change.ps1 -CheckReceipt
```
