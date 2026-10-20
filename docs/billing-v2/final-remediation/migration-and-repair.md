# 套餐与积分 V2 数据库迁移演练与异常审计报告

本报告记录 RedBase 套餐与积分 V2 在经过 V13、V14、V15 以及本次新增 V16 增量迁移后的完整验证与生产 dry-run 审计结果。

## 1. 版本化增量迁移演进历史

| 迁移版本 | 迁移名称 | 核心表结构与索引变更 | 业务目标 |
| :--- | :--- | :--- | :--- |
| **V13** | `billing-v2-schema` | 创建 `subscriptions`、`subscription_grants`、`subscription_schedules`、`credit_lots`、`credit_lot_allocations` | 建立批次账本与周期订阅基础设施 |
| **V14** | `billing-v2-safeguards` | 增加 subscriptions 历史迁移字段 `upgrade_cumulative_exact`，创建活跃订阅部分唯一索引 | 杜绝重复活跃订阅，防止历史数据升级计算截断 |
| **V15** | `billing-v2-closeout` | 创建 `task_credit_reservations` 表，为 `users` 增加 `legacy_credits_migrated`，为 `payment_orders` 增加快照与对账字段 | 解决任务跨期预占物理隔离与存量库升级安全 |
| **V16** | `billing-v2-remediation` | 1. 创建 `account_plan_order_locks` 引擎级互斥锁表<br>2. 为 `task_credit_reservations` 补充 `task_key` 业务复合索引<br>3. 为 `credit_lots` 增加 `grant_id` 与 `(order_id, source_type)` 唯一约束 | 解决跨进程并发下单互斥、跨进程调度发放幂等与任务账户归属隔离 |

## 2. 数据库迁移演练结果 (node scripts/rehearse-billing-migration.js)

演练脚本全面覆盖 6 种历史演化场景，执行全部 100% 通过：
1. **全新数据库初始化**：执行全部 16 个迁移版本，表结构、外键与索引完备。
2. **改造前旧库平滑直升**：完全未开账用户生成永久 `legacy` 批次，幂等重跑不重复发分。
3. **已执行 V13 库平滑增量升级**：无损升级至 V16，原有数据完全保留。
4. **在途任务隔离结算**：旧在途请求与新批次预占隔离核算，钱包读取无差额。
5. **已付未履约数据对账**：未履约订单在升级后可正常恢复履约，不丢失付款事实。
6. **V13 纯 cycle 批次账户升级**：已开账周期积分（如 400 分）升级后绝不凭空增加永久积分，到期安全归零。

## 3. 存量异常审计 (DRY-RUN 模式: node scripts/audit-and-repair-billing-v2.js)

运行当前工程审计工具对本地数据库进行无损扫描，审计结果如下：
- **用户开账分类统计**：
  - 分类 A（完全未开账历史用户）：0 人
  - 分类 B（合法 V13+ 账本用户）：3 人
  - 分类 C（缓存与批次不一致异常账户）：0 人
  - 分类 D（错误生成重复永久批次账户）：0 人
- **订阅与排期状态**：
  - 重复 active 订阅冲突账户数：0
  - 待生效排期有效性：正常
- **订单履约审计**：
  - 已支付未履约订单数：0
  - 待人工核查 (audit_required) 订单数：1（历史构造的异常审计样例）
  - 已过期缺失流水批次数：0
