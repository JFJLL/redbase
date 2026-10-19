# 数据库迁移验证与存量数据审计报告 (Migration Verification & Audit)

## 一、迁移版本演进与职责划分 (V13 -> V18)

- **V13 (`billing-v2-subscription-ledger`)**：初次建立 `credit_lots`, `subscriptions`, `subscription_schedules`, `subscription_grants`, `billing_quotes`, `payment_orders`，并对历史有效余额进行 `legacy` 永久批次结转。
- **V14 (`billing-v2-remediation`)**：引入 `account_plan_order_locks`，增加 `snapshot_json`、`anchor_day`，为日历月计算与防重提供底层字段。
- **V15 (`billing-v2-closeout`)**：引入 `task_credit_reservations` 预占关系表，修复存量用户 `legacy_credits_migrated` 标志。
- **V16 (`billing-v2-remediation`)**：为 `task_credit_reservations` 补充 `task_key` 列，并建立 `uq_credit_lots_grant` 唯一索引。
- **V17 (`billing-v2-remaining-closeout`)**：在 SQLite 层面完整重建 `task_credit_reservations` 表，将物理主键变更为自增 `id INTEGER PRIMARY KEY AUTOINCREMENT`，将业务唯一约束确立为 `UNIQUE(task_key, lot_id)`。
- **V18 (`billing-v2-reservation-identity-alignment`)**【本轮新增】：
  1. 为 `trend_analysis_requests` 和 `excellent_remix_billing_requests` 增加 `task_key` 列并全量回填。
  2. 识别历史非规范旧键（如 `trend_analysis:<userId>:<requestId>` 或缺少 brand/bucket 的旧键），反查真实业务表，原子升级为完整规范键 `trend_analysis:<userId>:<brandId>:<bucketKey>:<requestId>`。
  3. 识别优秀内容旧任务键，将其与 `created_at` 执行令牌完全对齐为 `excellent_<kind>:<userId>:<requestId>:<createdAt>`。
  4. 对歧义匹配（如一个 request_id 对应多条记录）标记为 `audit_required`，不盲目乱猜。
  5. 自动审计并回填 `subscriptions.snapshot_json` 为空的存量有效订阅，确保后续升级始终有据可查。

---

## 二、隔离迁移演练场景验证 (8 大场景 100% 通过)

执行命令：`node scripts/rehearse-billing-migration.js`

1. **场景 1：全新数据库初始化与 V14/V17/V18 迁移验证**
   - 验证结果：表结构、主外键、唯一约束（如 `uq_task_res_key_lot`, `uq_credit_lots_grant`）及新增列校验通过。
2. **场景 2：改造前旧数据库直接升级至最新版本**
   - 验证结果：存量旧用户积分准确结转为 `legacy` 永久批次，多次执行幂等且积分总额零偏差。
3. **场景 3：已执行 V13 的数据库平滑增量升级**
   - 验证结果：无重复开账，增量字段安全追加。
4. **场景 4 & 5：在途预占、已付未履约与异常数据审计修复演练**
   - 验证结果：在途预占隔离结算成功，不误扣不丢失。
5. **场景 6：V13 仅有 cycle 批次账户升级验证（N1 硬断言）**
   - 验证结果：已有 `cycle` 批次用户绝不重复生成 `legacy` 永久批次，周期结束后积分安全归零。
6. **场景 7：V17 物理主键重建与到期防重规范化演练**
   - 验证结果：`task_id` 物理主键成功解耦，多品牌相同 request_id 完全隔离；旧到期流水不重复追加。
7. **场景 8：V18 任务身份规范对齐与订阅快照回填演练**
   - 验证结果：旧键成功升级为五段式规范键，并在任务结算时准确找到原批次完成核销。

---

## 三、生产数据库 Dry-Run 离线审计结果

执行脚本：`node scripts/audit-and-repair-billing-v2.js`
- 结果：
  - 分类 A（完全未开账历史用户）：0 人
  - 分类 B（合法 V13+ 账本用户）：5 人
  - 分类 C（缓存与批次不一致异常）：0 账户需要人工修正
  - 重复 active 订阅冲突：0
  - 已支付未履约订单：0
  - 待核查订单：已受控记录并保留排他性审计理由
