# 套餐与积分 V2 快照与迁移来源修复专项测试矩阵与原始日志索引

## 一、J1—J3 专项回归矩阵

| 用例 ID | 测试名称 | 断言目标 | 结果 |
|---|---|---|---|
| **J1-Std** | `J1: Annual subscription upgraded in Month 12 preserves 400 entitlement` | 轻量版年付第 12 期发出 100 分后升级专业版，已生效升级 400 分不被第 12 期 grant 覆盖；损坏快照经 V20 迁移安全修复为 400；再次升级差额从 400 计算（差额 1100，非 1400） | **PASS** (35.6ms) |
| **J1-Cov1** | `J1 Coverage: Upgrade in Month 1, Month 6, and upgrade with issuedNow = 0` | 覆盖第 1 期升级（未来 pending 更新）、第 6 期升级（历史 granted 保持、pending 更新），以及期末 `issuedNow = 0`（无升级批次）时仅凭已生效升级订单仍正确恢复 400 分 | **PASS** (13.3ms) |
| **J1-Cov2** | `J1 Coverage: Consecutive upgrades in month 12 (Light -> Pro -> Business)` | 同一周期内轻量 -> 专业 -> 业务连续升级，有效升级链顺序还原，最终快照精确指向 1500 分 | **PASS** (28.6ms) |
| **J2-Std** | `J2: paid + audit_required upgrade does not change current entitlement` | 专业版 400 分订阅持有 `status = 'paid'` 但 `fulfillment_status = 'audit_required'` 的业务版升级单；订阅保持 Pro 400，快照还原为 400，订单保持待核查状态与真实付款 | **PASS** (11.8ms) |
| **J2-Cov** | `J2 Coverage: paid + unfulfilled and paid + processing do not alter active entitlement` | 覆盖未履约与处理中订单，均不改变有效订阅档位与月度额度，归入待履约证据链 | **PASS** (7.8ms) |
| **J3-Std** | `J3: Subscription with missing provenance cannot borrow another subscription's older order` | 同一用户历史已过期订阅订单（100分）绝不借用给当前孤立专业版订阅；返回 `unresolved`；升级报价抛出客服核查异常，用户独立永久积分不受影响 | **PASS** (9.9ms) |
| **J3-Cov** | `J3 Coverage: Subscription with conflicting candidate orders flags conflict` | 订阅记录档位与来源订单存在冲突时返回 `conflict` 并拒绝自动覆盖写入 | **PASS** (2.2ms) |

---

## 二、保留的 I1—I4 既有核心回归

- **I1（结算原子性与事务回滚）**: 9/9 PASS（`tests/credits/billing-v2-attempt-and-migration-fix.test.js`）。
- **I2（生成尝试身份与迟到失败防御）**: PASS，旧尝试迟到失败通知安全忽略。
- **I3（多尝试独立身份与 V18 唯一键消除）**: PASS，历史终态与重试记录独立持有真实时间戳。
- **I4（排期与升级链隔离）**: PASS，排期业务版 1500 分与当期专业版 400 分互不覆盖。

---

## 三、原始运行日志文件索引

所有原始日志保存在本目录 `logs/` 下：
- `logs/j1-j3-tests.log`: J1-J3 专项套件运行日志（7/7 PASS）。
- `logs/credits-all-tests.log`: 计费与积分 112 项全量回归日志（112/112 PASS）。
- `logs/payment-reconcile-tests.log`: 支付网关、主动查单与对账日志（28/28 PASS）。
- `logs/migration-rehearsal.log`: 数据库全场景迁移隔离演练日志（10/10 场景 PASS）。
- `logs/audit-dryrun.log`: 真实数据库快照与来源离线 Dry-Run 审计日志。
- `logs/npm-check.log`: 服务端全量 88 个源码文件语法与依赖检查日志（0 错误）。
- `logs/frontend-typecheck.log`: 前端 `vue-tsc` 全量类型检查日志（0 错误）。
- `logs/frontend-tests.log`: 前端 Vitest 单元测试运行日志（57 文件 412/412 PASS）。
- `logs/browser-e2e.log`: 真实浏览器端到端订单与履约测试日志（5/5 PASS）。
- `logs/full-npm-test.log`: 后端全量测试套件运行日志（913 PASS / 4 FAIL 既有 AnySearch 外部基线）。
