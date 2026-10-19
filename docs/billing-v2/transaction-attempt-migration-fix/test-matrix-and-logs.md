# 测试矩阵、执行证据与原始日志对照

## 1. 专项回归测试矩阵 (I1 - I4 & 并发)

测试文件：[tests/credits/billing-v2-attempt-and-migration-fix.test.js](/D:/download/pic-vec/redbase-fullstack-latest/tests/credits/billing-v2-attempt-and-migration-fix.test.js)

| 用例编号 | 场景描述 | 关键输入与触发条件 | 期望输出与断言 | 执行结果 |
| :--- | :--- | :--- | :--- | :--- |
| **I1** | 结算注入 DB 异常原子回滚 | 10分用户预占1分，在 `credit_lot_allocations` 注入失败触发结算 | 抛出原始DB错误（非402），已扣0，预占保持1，流水0条，业务请求仍为 reserved；显式 fail 后可用恢复10，预占0 | **PASS** (16.5ms) |
| **I1-Cov** | 结算重试成功与幂等重放 | 撤销注入错误后调用正常结算，紧接着二次回调 | 首次正常扣费1，总可用9；二次重放 `replayed=true, charged=false`，总可用保持9，流水不重复 | **PASS** (4.3ms) |
| **I2** | T1 迟到失败不污染 T2 预占 | T1失败释放 -> T2重试预占 -> 迟到T1失败到达 | T1迟到返回 stale 忽略；T2 保持 reserved 预占1，可用仍为9；T2随后结算消费1，最终可用9 | **PASS** (6.3ms) |
| **I2-Cov** | 缺失token/错误签名/已完成防护 | 传入空 token、错误 inputSignature，或在T2已完成后到达T1失败 | 前二者拒绝触碰资金并抛出 STALE_BILLING_ATTEMPT；已完成后的迟到失败零副作用静默忽略 | **PASS** (7.0ms) |
| **I3** | 历史多尝试同批次迁移防冲突 | 同一 lot_id 上存在 T1 (released) 与 T2 (reserved) | V18/V19 迁移平稳通过，无 UNIQUE 冲突；T1 与 T2 保持独立时间戳与状态，资金不漂移 | **PASS** (1.2ms) |
| **I4a** | 当前 Pro + 未来排期 Business 快照隔离 | Pro 月付 (400) + 提前购买下月 Business 年付 (1500) | V19 修复后当前订阅快照严格回填为 400 (pro)；排期订阅保持 1500，互不污染覆盖 | **PASS** (10.8ms) |
| **I4b** | 年付升级完整权益与首期历史保留 | Light 年付首期发100 -> 中途升级 Pro 年付 -> 推进至第2期 | V19 修复后当前订阅快照为 400 (pro)；第1期历史发放保持100；再升级按 1500-400 计算补发 | **PASS** (8.7ms) |
| **I4-Cov** | 缺失来源订阅明确进入核查 | 插入孤立订阅且无法唯一追溯开通与升级订单 | `reconstructSubscriptionSnapshot` 返回 null，升级报价抛出核查异常，拒绝猜目录价格 | **PASS** (1.4ms) |
| **Multi-Proc** | 真实多进程磁盘 SQLite 竞争结算 | 2 个 worker 进程并发争抢结算同一预占 | 严格仅有 1 个 worker 成功扣款，另 1 个幂等重放，总扣减严格为 1 | **PASS** (366.3ms) |

---

## 2. 全套测试执行数据与日志索引

| 测试套件 | 执行命令 | 通过 / 总数 | 退出码 | 原始日志路径 |
| :--- | :--- | :--- | :--- | :--- |
| **I1 - I4 专项回归** | `node scripts/run-node-tests.js tests/credits/billing-v2-attempt-and-migration-fix.test.js` | **9 / 9 PASS** | 0 | `docs/billing-v2/transaction-attempt-migration-fix/logs/i1-i4-tests.log` |
| **积分与计费全量** | `node scripts/run-node-tests.js tests/credits` | **105 / 105 PASS** | 0 | `docs/billing-v2/transaction-attempt-migration-fix/logs/credits-tests.log` |
| **支付通知与对账** | `node scripts/run-node-tests.js tests/api/payment-routes.test.js tests/repositories/reconcile-orders.test.js ...` | **37 / 37 PASS** | 0 | `docs/billing-v2/transaction-attempt-migration-fix/logs/payment-and-reconcile-tests.log` |
| **迁移演练 (V1..V19)** | `node scripts/rehearse-billing-migration.js` | **9 / 9 场景 PASS** | 0 | `docs/billing-v2/transaction-attempt-migration-fix/logs/migration-rehearsal.log` |
| **数据库账务审计** | `node scripts/audit-and-repair-billing-v2.js` | **0 异常挂起** | 0 | `docs/billing-v2/transaction-attempt-migration-fix/logs/audit-database.log` |
| **服务端语法检查** | `npm run check` | **88 文件 0 errors** | 0 | `docs/billing-v2/transaction-attempt-migration-fix/logs/npm-check.log` |
| **前端单元测试** | `npm run test:frontend` | **412 / 412 PASS** | 0 | 终端完整执行 |
| **前端类型检查** | `npm run typecheck:frontend` | **0 errors** | 0 | 终端完整执行 |
| **生产打包构建** | `npm run build` | **成功输出 dist/public** | 0 | 终端完整执行 |
| **真实浏览器 E2E** | `node scripts/verify-closeout-browser-e2e.cjs` | **5 / 5 PASS** | 0 | `docs/billing-v2/transaction-attempt-migration-fix/logs/browser-e2e.log` |
| **后端全量对照** | `npm test` | **906 PASS / 4 FAIL** (4项均为既有 AnySearch 基线) | 1 | `docs/billing-v2/transaction-attempt-migration-fix/logs/full-npm-test.log` |
