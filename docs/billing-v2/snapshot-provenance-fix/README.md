# 套餐与积分 V2 快照恢复与迁移来源一致性修复 (J1—J3) 交付说明

## 一、基线与提交状态

- **仓库**: `JFJLL/redbase`
- **本地路径**: `D:\download\pic-vec\redbase-fullstack-latest`
- **功能分支**: `codex/billing-v2-subscription-wallet`
- **远端追踪**: `origin/codex/billing-v2-subscription-wallet`
- **本轮起始审查基线 SHA**: `29d35d05f4c443bb6ce8a3b8f8207b3b6aac7490`
- **审查基线父提交 SHA**: `ab59df06bb634f70de41d56689c9616ba776e016`
- **操作原则**:
  - 严格遵循用户指示：“每次做完先不要合并 但是可以提交推送到远程”。
  - 严禁合并到 `master`，严禁生产部署，严禁变更生产数据库，严禁真实付款或退款。

---

## 二、J1—J3 核心问题与根因修复总结

| 编号 | 缺陷现象 | 根因机制 | 修复方案 | 验证用例 |
|---|---|---|---|---|
| **J1** | 年付最后一期升级专业版后，快照被历史 grant 降回 100 分 | 恢复逻辑中无条件用 `SELECT credits FROM subscription_grants ORDER BY period_index DESC LIMIT 1` 覆盖已由升级订单计算出的 400 分，V19 随后将正确快照改写为 100 | 重构生效链追溯：已生效升级订单权威性高于历史已发放记录；历史 grant 仅证明发放历史，不再覆盖升级后的当前完整月度权益；在最后一期无 pending grant 时仍按有效升级链恢复 400 分 | `J1: Annual subscription upgraded in Month 12 preserves 400` |
| **J2** | `paid + audit_required` 待核查订单被误当成已生效升级，将 Pro 400 误推断为 Business 1500 | 升级订单查询条件为 `status = 'paid'`，未校验 `fulfillment_status = 'fulfilled'`，待核查订单被混入有效升级链 | 严格区分付款事实与履约状态：仅 `fulfillment_status = 'fulfilled'` 的订单计入生效升级链；待核查订单归入 `unfulfilledUpgrades`，保持订阅原 Pro 400 权益不被污染，订单保留待核查状态 | `J2: paid + audit_required upgrade does not change current entitlement` |
| **J3** | 无明确来源的订阅通过 `created_at <= service_start` 借用了同用户早期的无关过期订阅订单 | 恢复逻辑在无关联记录时回退到同用户时间早于服务开始的任意 activate 订单，强行将旧订单归属拼凑给当前订阅 | 彻底删除时间先后推断逻辑；严格依据批次关联、快照外键、排期激活记录证明归属；无法证明归属时明确返回 `unresolved` 并标记 `audit_required`，严禁猜测目录或借用旧单 | `J3: Subscription with missing provenance cannot borrow another subscription's older order` |

---

## 三、修改与新增的关键文件

1. **`src/server/billing/snapshot-recovery.js`**:
   - 重构快照恢复与审计核心：提供结构化 `inspectSubscriptionSnapshot(sub, db)` 与 `reconstructSubscriptionSnapshot(sub, db)`。
   - 严格要求可审计来源（批次订单关联、排期激活、明确 subscriptionId 外键）。
   - 过滤升级订单仅采纳已履约（`fulfillment_status = 'fulfilled'`）。
   - 年付历史 grant 绝不降档已生效升级。
   - 提供 `safeUpdateSubscriptionSnapshot` 乐观并发保护。

2. **`src/server/billing/quote-service.js`**:
   - `getSubscriptionSnapshot` 接入 `inspectSubscriptionSnapshot`。
   - 严格校验一致性：恢复结果与当前 `sub.plan_id` 矛盾时拒绝采纳，防止 `pro` 订阅被污染为 `business` 计算报价。
   - 对 `unresolved` 或 `conflict` 订阅安全拒绝报价并抛出客服核查异常，防止错误计费。

3. **`src/server/db/migrations.js`**:
   - 修正 Migration 18 与 19 调用修复后的恢复函数，避免新库或从 V18 升级的数据库产生错误回填。
   - 新增 **Migration 20** (`billing-v2-snapshot-provenance-repair`)：针对已经执行过旧 V19 的数据库，自动扫描并修正被误降级的 J1 快照（100 -> 400）、被误升级的 J2 快照（1500 -> 400），并清理被无来源借用的 J3 虚假快照（清空进入核查）。

4. **`scripts/audit-and-repair-billing-v2.js`**:
   - 接入结构化审计，输出 `inspectionStatus`、`inspectionReason`、有效升级链、待核查升级单及自动写入判断。
   - 默认保持安全 DRY-RUN 模式。

5. **`scripts/rehearse-billing-migration.js`**:
   - 扩充演练场景 10 (`testV20SnapshotProvenanceRepair`)，覆盖 J1、J2、J3 的完整数据迁移自愈演练。

6. **`tests/credits/billing-v2-snapshot-provenance-fix.test.js`**:
   - 新建专项端到端测试套件，覆盖 J1-J3 及其反例、边界与稳定性场景（7/7 PASS）。

---

## 四、测试与演练运行结果

| 验证范围 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| **J1—J3 专项测试** | `node --test tests/credits/billing-v2-snapshot-provenance-fix.test.js` | **7 / 7 PASS** | ~0.3s |
| **计费与积分全量套件** | `node scripts/run-node-tests.js tests/credits` | **112 / 112 PASS** | ~1.4s |
| **支付与对账套件** | `node --test tests/api/payment-routes.test.js tests/api/reconcile-orders.test.js` | **28 / 28 PASS** | ~0.4s |
| **数据库隔离演练 (V1..V20)** | `node scripts/rehearse-billing-migration.js` | **10 / 10 场景 PASS** | ~0.5s |
| **账务离线 Dry-Run 审计** | `node scripts/audit-and-repair-billing-v2.js` | **0 异常挂起，精确识别 4 个待核查** | ~0.4s |
| **服务端语法检查** | `npm run check` | **88 个文件 0 错误 (Exit 0)** | ~7.4s |
| **前端类型检查** | `npm run typecheck:frontend` | **0 错误 (Exit 0)** | ~6.8s |
| **前端单元测试** | `npm run test:frontend` | **57 文件 412 / 412 PASS** | ~19.6s |
| **生产环境构建** | `npm run build` | **打包成功输出 dist/public (Exit 0)** | ~3.0s |
| **真实浏览器 E2E 测试** | `node scripts/verify-closeout-browser-e2e.cjs` | **5 / 5 断言 PASS** | ~1.2s |
| **后端全量 npm test 对照** | `npm test` | **913 PASS / 4 FAIL** (4 项失败均为既有的 AnySearch 网络环境基线，非计费模块引入) | ~4.9s |
