# 数据迁移演练与异常审计处置报告 (Migration & Repair)

## 1. 迁移版本演进与增量方案 (V17)

当前系统版本迁移完整链路：
- **V1—V12**：基础业务表（用户、品牌、分析、内容、生成任务、图片任务等）。
- **V13**：计费 V2 首次演进（引入 `credit_lots`, `credit_events`, `subscriptions`, `subscription_schedules` 等）。
- **V14**：历史保留积分结转保护与日历锚点修复。
- **V15**：在途任务预占表初始化 (`task_credit_reservations`)。
- **V16**：订单排他锁 (`account_plan_order_locks`) 与初版 `task_key` 字段。
- **V17 (本轮新增)**：`task_credit_reservations` 物理主键重建与唯一约束迁移至 `(task_key, lot_id)`。

### V17 迁移核心逻辑与安全性保证
1. **重建策略**：由于 SQLite 无法通过 ALTER TABLE 修改 PRIMARY KEY，V17 创建 `task_credit_reservations_v17`，定义 `id INTEGER PRIMARY KEY AUTOINCREMENT` 与 `UNIQUE(task_key, lot_id)`。
2. **存量数据平滑迁移**：从旧表读取全部历史记录。若缺少规范 `task_key`，根据 `user_id` 与关联业务表（`trend_analysis_requests` / `excellent_remix_billing_requests`）恢复完整四元组/三元组身份。
3. **外键与索引重置**：重命名回原表名后，重建所有覆盖索引与外键检查，通过 `PRAGMA foreign_key_check` 保证 100% 干净。

---

## 2. 隔离演练场景与测试证据 (`scripts/rehearse-billing-migration.js`)

执行命令：`node scripts/rehearse-billing-migration.js`

| 演练场景 | 验证内容 | 预期结果 | 实际执行结果 |
| :--- | :--- | :--- | :--- |
| **场景 1** | 全新数据库初始化从 V1 依次执行至 V17 | 所有表及新老字段完整建立，外键一致 | ✔ 验证通过 |
| **场景 2** | 改造前旧数据库直接升级至当前版本 | 历史余额迁入 `source_type = 'legacy'` 永久批次，多次执行幂等无增发 | ✔ 验证通过 (3 账户，1750 积分) |
| **场景 3** | 已执行 V13 库增量升级 | 不重复生成永久批次，表结构安全对齐 | ✔ 验证通过 |
| **场景 4 & 5** | 在途预占与排期已付未履约数据演练 | 在途任务隔离扣减，激活后状态变为 fulfilled | ✔ 验证通过 |
| **场景 6** | V13 纯 cycle 批次升级验证 (N1 硬断言) | 用户初始 400 cycle 积分，升级后仍为 400，到期后安全归零不残留永久副本 | ✔ 验证通过 |
| **场景 7** | V17 物理主键重建与旧到期规范化演练 | 主键变更为 id，多品牌共用 requestId 无冲突；已记账到期批次 normalization 0 增量 | ✔ 验证通过 |

---

## 3. 生产/副本数据审计与处置 (`scripts/audit-and-repair-billing-v2.js`)

执行命令：`node scripts/audit-and-repair-billing-v2.js`

```text
=== RedBase 套餐与积分 V2 数据库账务与迁移审计 (DRY-RUN 模式) ===

[用户开账状态审计]
- 分类 A（完全未开账历史用户）: 0 人
- 分类 B（合法 V13+ 账本用户）: 4 人
- 分类 C（缓存与批次不一致异常）: 0 人
- 分类 D（疑似受旧 V14 影响生成重复永久批次）: 0 人

[订阅状态审计]
- 重复 active 订阅冲突账户数: 0

[订单履约与核查审计]
- 已支付未履约 (paid + unfulfilled) 订单数: 0
- 待核查 (audit_required) 订单数: 1 (符合测试注入用例)
- 已过期但缺失 cycle_expire 流水批次数: 0

=== 审计完成 ===
```

**审计规则与安全边界**：
- **默认 Dry-Run**：审计脚本默认仅进行只读对账和分类排查，不执行任何破坏性写入。
- **异常数据隔离**：缺少证据或无法完全归属的异常账户统一进入人工核查队列（`audit_required`），绝不自动删分、退款或截断历史流水。
