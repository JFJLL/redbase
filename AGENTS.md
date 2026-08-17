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
- Disposable benchmark output belongs in ignored `outputs/`.
- Preserve unrelated worktree changes. Do not commit, push, deploy, or enable hooks/CI without explicit user instruction.

## Branch and server deployment

- `master` is the canonical production branch. New feature branches must start from an up-to-date `master`.
- The production checkout at `/home/red/work/moneyboost/redbase` must remain on `master`; do not deploy feature, rescue, or UI experiment branches.
- The server deploy key is intentionally read-only. Push commits from an authorized local development machine, never from the server.
- Before a server update, require a clean `git status --short`, then use `git switch master`, `git pull --ff-only origin master`, and `pm2 restart redbase`.
- Do not use force-push, destructive reset, or branch rewriting as part of the deployment flow.
