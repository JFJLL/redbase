# 套餐与积分 V2 事务、重试身份与 V18 迁移定向修复交付文档

## 一、交付基线与分支状态

- **项目仓库**：`JFJLL/redbase`
- **本地工作区**：`D:/download/pic-vec/redbase-fullstack-latest`
- **目标分支**：`codex/billing-v2-subscription-wallet`
- **起始审查提交**：`ab59df04646a782bb0a04910efc79bc5c3789437`
- **直接父提交**：`8aff5fb9620b7a44b2293be452ebf189bdb17ce1`
- **交付范围**：代码修复、增量迁移（V18防冲突保护 + V19增量修复）、专项与全量回归、迁移演练、浏览器端到端及完整测试日志。

---

## 二、修改文件列表

1. `src/server/db/repositories/excellent-remix-billing-repository.js`
   - **I1**：移除结算过程中的内部异常吞并逻辑，实现扣减、分配、流水、缓存同步及请求状态在单事务中的完整回滚。
   - **I2**：重构 `failExcellentBillingRequest`，强制校验 `reservationToken`，建立尝试预占身份隔离，彻底消除旧尝试迟到失败对新活跃尝试预占的误释放。
2. `src/server/billing/snapshot-recovery.js`
   - **新增**：封装 `reconstructSubscriptionSnapshot`，严格依据订阅的批次开通订单、升级交易链及年付发放记录唯一还原当前月度额度与计价基础，绝不从当前目录或无关未绑定订单猜测。
3. `src/server/billing/quote-service.js`
   - **I4**：更新 `getSubscriptionSnapshot` 接入精确快照追溯模块；在 `createQuote` 升级计算中移除回退到当前目录的旁路，无法唯一重建的订阅明确抛出核查异常。
4. `src/server/db/migrations.js`
   - **I3**：完善 Migration 18 对 `excellent_*` 任务键对齐的防冲突保护，已规范键不重写，历史终态记录使用自身时间戳，防止触发 `UNIQUE(task_key, lot_id)` 崩溃。
   - **I3 & I4**：新增 Migration 19 (`billing-v2-attempt-identity-and-snapshot-repair`)，自动扫描修复历史错误改写键，并纠正受旧迁移影响的订阅快照（I4a 与 I4b）。
5. `scripts/audit-and-repair-billing-v2.js`
   - **I4**：在离线账务审计中追加第 5 项“订阅快照真实权益审计”，列出订阅 ID、候选来源、有效升级链、当前快照、预期权益与处置结论。
6. `scripts/rehearse-billing-migration.js`
   - 增加场景 8 针对同一批次多尝试并发迁移的安全断言；增加场景 9 针对 V19 修复 I4a、I4b 快照回填演练。
7. `tests/repositories/migration-zero-loss.test.js`
   - 更新版本化迁移版本列表断言至 `[1..19]`。
8. `tests/credits/billing-v2-attempt-and-migration-fix.test.js`
   - **新增**：包含 I1、I2、I3、I4a、I4b 及真实多进程磁盘 SQLite 竞争结算等 9 个专项回归用例，100% 通过。

---

## 三、本地复核与验证命令

```powershell
# 1. 运行 I1 - I4 专项回归
node scripts/run-node-tests.js tests/credits/billing-v2-attempt-and-migration-fix.test.js

# 2. 运行计费与积分全量套件 (105 / 105 PASS)
node scripts/run-node-tests.js tests/credits

# 3. 运行隔离数据迁移演练 (9 / 9 场景 PASS)
node scripts/rehearse-billing-migration.js

# 4. 运行账务离线 Dry-Run 审计
node scripts/audit-and-repair-billing-v2.js

# 5. 服务端语法检查
npm run check

# 6. 前端全套测试与类型检查
npm run test:frontend
npm run typecheck:frontend

# 7. 生产构建打包
npm run build

# 8. 真实浏览器端到端验证
node scripts/verify-closeout-browser-e2e.cjs
```
