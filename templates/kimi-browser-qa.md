# Kimi Browser QA

## Run metadata

- changeSetHash: ``
- Date/time: `YYYY-MM-DD HH:MM` (Asia/Shanghai)
- Tester: Codex + Kimi WebBridge
- WebBridge session:
- Environment / URL:
- App version or commit:
- Browser:

> changeSetHash 必填，来自 `verify-change.ps1 -PlanOnly` 输出。不填或与当前 change set 不一致，验证器判定证据无效。

## Required cases

| Case ID | Journey | Why this diff can affect it | Result | Evidence |
|---|---|---|---|---|
| KIMI-001 | Changed happy path |  | pending |  |

按 PlanOnly 返回的 evidenceCases 增补以下条件 case：

| Case ID | 适用场景 | Result | Evidence |
|---|---|---|---|
| KIMI-002 | 有远程请求、异步状态 → 失败与恢复 |  |  |
| KIMI-003 | 有持久化、历史、刷新 → 刷新/返回后状态 |  |  |
| KIMI-004 | auth / permission / tenant / credit → 权限与账号边界 |  |  |
| KIMI-005 | payment / submit / job / retry → 重复提交与幂等 |  |  |
| KIMI-006 | upload / large input / AI generation → 大输入、慢路径、取消 |  |  |

## Execution detail

### KIMI-001 — Changed happy path

- Start state:
- Steps:
- Expected:
- Actual:
- Result: `pass | fail | blocked`
- Screenshots:
- Relevant network requests:

### KIMI-00X — Additional case

- Start state:
- Failure injected or input used:
- Steps:
- Expected:
- Actual:
- Result: `pass | fail | blocked`
- Screenshots:
- Relevant network requests:

## Exploratory observations

- Loading and disabled states:
- Empty and error states:
- Duplicate actions / idempotency:
- Permission or account boundaries:
- Visual overflow, focus, and actionable feedback:

## Findings and regression mapping

| Finding | Severity | Reproduction | Root layer | Regression destination | Status |
|---|---|---|---|---|---|
|  |  |  | unit / API / domain / data / UI-only | test path or Kimi case ID | open / fixed / verified |

## Verdict

- Overall: `pass | fail | blocked`
- Remaining risk:
- Evidence completeness:
- Follow-up:
