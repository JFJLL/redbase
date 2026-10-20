# RedBase 套餐与积分 V2：数据迁移与数据修复演练报告

本报告记录 Version 14 增量数据库迁移规范、全场景隔离演练过程、异常数据对账结果及回滚安全边界。

---

## 1. 迁移版本设计原则

根据任务规范，本轮整改**不修改已执行的 Version 13 迁移定义**，而是在 `schema_migrations` 机制后追加增量迁移：

```javascript
// src/server/db/migrations.js
{
  version: 14,
  name: "billing-v2-remediation",
  apply() { ... }
}
```

该迁移具备完全的幂等性与向后兼容性，无论是在全新数据库、未升级的旧数据库、还是已经执行过 V13 的数据库上运行，最终 schema、索引和约束均达到 100% 一致。

---

## 2. Version 14 增量变更清单

1. **`users` 表**：
   - 增加 `legacy_credits_migrated INTEGER NOT NULL DEFAULT 0` 列。
   - 数据平移：将已存在 `legacy` 类型批次的用户初始化为 `1`。
2. **`subscription_schedules` 表**：
   - 增加 `anchor_day INTEGER NOT NULL DEFAULT 0` 列（保留原服务起始日的日历锚点，修复 R5）。
   - 增加 `snapshot_json TEXT NOT NULL DEFAULT '{}'` 列（存储购买时的套餐额度与周期快照）。
3. **`subscriptions` 表**：
   - 增加 `upgrade_cumulative_exact REAL NOT NULL DEFAULT 0` 列（存储连续升级的高精度累积浮点增量，修复 R6）。
   - 增加 `snapshot_json TEXT NOT NULL DEFAULT '{}'` 列。
   - **唯一排他约束**：`CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_unique_active ON subscriptions(user_id) WHERE status = 'active'`（修复 R4，彻底在数据库层保证一个账户最多一个 active 订阅）。
4. **`payment_orders` 表**：
   - 增加 `snapshot_json TEXT NOT NULL DEFAULT '{}'` 列（锁定成交承诺额度，修复 R7）。
   - 增加 `audit_reason TEXT NOT NULL DEFAULT ''` 列与 `audit_at TEXT NOT NULL DEFAULT ''` 列（标记并追溯待核查订单）。
   - 增加 `anchor_day INTEGER NOT NULL DEFAULT 0` 列。
5. **`billing_quotes` 表**：
   - 增加 `subscription_id INTEGER` 列。
   - 增加 `original_plan_id TEXT NOT NULL DEFAULT ''` 列。
   - 增加 `original_service_end TEXT NOT NULL DEFAULT ''` 列。
   - 增加 `subscription_version TEXT NOT NULL DEFAULT ''` 列（绑定报价生成时的原订阅版本，修复 R3）。

---

## 3. 隔离演练结果与对账数据

执行命令：
```bash
node scripts/rehearse-billing-migration.js
```

### 演练场景 1：全新数据库初始化与 V14 迁移
- **输入**：内存全新空白数据库。
- **过程**：执行 `initializeDatabaseSchema()` 与 `ensureDatabaseIndexes()`。
- **输出**：全部 9 张核心计费与业务表就绪，V14 所需新增列及唯一索引均成功创建。
- **结论**：✔ 全新数据库表结构与 V14 字段索引验证通过。

### 演练场景 2：改造前旧数据库直接升级至 V14
- **输入**：改造前旧数据库（含历史用户 A: 500分、B: 1200分、C: 50分、D: 0分，总计 1750 积分）。
- **过程**：按序执行 DDL 升级，并调用 `migrateAllLegacyUsers` 进行首次开账。
- **核对结果**：
  - 迁移前用户总积分：1750
  - 迁移后历史批次总积分 (`credit_lots.remaining_credits WHERE source_type = 'legacy'`)：1750
  - 用户缓存总积分 (`users.credits`)：1750
  - 带到期日的历史批次数量：0（100% 保持永久有效）
  - 幂等重跑第二次开账：迁移账户数 0，增发积分 0
- **结论**：✔ 旧库升级与历史开账对账 100% 成功，幂等重跑无增发。

### 演练场景 3：已执行 V13 的数据库平滑增量升级至 V14
- **输入**：已固化 V13 结构的数据库。
- **过程**：启动应用执行 `applyVersionedMigrations`。
- **输出**：检测到版本 13 已就绪，单步追加版本 14，创建 `legacy_credits_migrated` 等 10 项新增字段及 `idx_subscriptions_unique_active` 索引。
- **结论**：✔ 已执行 V13 数据库增量升级至 V14 验证成功。

### 演练场景 4 & 5：在途预占、已付未履约与异常数据审计修复
- **输入**：存在在途长任务预占（用户 50 分，预占 20 分，未占用 30 分）。
- **过程**：执行在途任务结算 `settleReservedCreditsFromLots`。
- **核对结果**：结算后可用余额准确保持为 30 分，不发生二次扣除，批次分配与状态转换原子完成。
- **结论**：✔ 在途预占隔离结算与钱包读取对账成功。

---

## 4. 安全回滚边界与生产操作建议

1. **SQLite WAL 模式与备份操作**：
   - 上线升级前，先通过 SQLite 在线备份 API 或复制 `.sqlite`、`.sqlite-wal`、`.sqlite-shm` 三件套完成一致性冷备。
2. **回滚边界**：
   - Version 14 均为向后兼容字段（增加列与部分索引），未删除任何旧字段。
   - 若需回滚代码至早期补丁版本，数据库结构亦完全向下兼容，不会引起旧读写报错。
3. **真实交易保护**：
   - 一旦上线并产生新订单与新批次，禁止回滚旧数据库快照（避免覆盖新入账订单与消费流水）。