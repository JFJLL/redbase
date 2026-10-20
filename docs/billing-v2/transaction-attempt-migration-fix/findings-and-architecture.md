# 套餐与积分 V2 事务、重试身份与 V18 迁移定向修复报告

## 1. 核心根因与修复调用链 (I1 - I4)

### I1: 优秀内容结算事务完整原子性保证

- **问题根因**：原 `settleExcellentBillingRequest` 在插入负向 `credit_event` 并调用 `settleCreditsForTask` 时包含了一个内部 `try...catch (settleErr)` 块。当批次扣减、分配插入或底层数据库发生异常时，异常在事务内部被吞并，并将业务请求置为 `failed` 且返回 `{ settleFailed: true }`。由于在事务闭包内返回普通对象，外层 `runTransaction` 判定成功并提交了事务，导致负向流水 `-1` 已持久化、批次已发生部分扣款，而后续才对外抛出 `INSUFFICIENT_CREDITS`。
- **修复方案**：
  1. 移除事务内部吞并扣款异常的 `try...catch` 逻辑。消费事件插入、批次结算与预占核销、用户余额缓存更新及请求置为 `completed` 必须在同一个单一数据库事务中原子执行。
  2. 结算事务中任意数据库约束、分配失败或磁盘故障均完整向外抛出，SQLite 事务全量回滚。已扣金额为 0、无孤立流水、原任务预占完好保留为 `reserved`。
  3. 若结算遇 `RESERVATION_NOT_FOUND`（如预占已由外部释放或超时），在事务回滚后通过独立外部步骤将请求标记为 `failed`，并抛出明确的未匹配预占错误，杜绝半扣款提交。
- **涉及文件**：
  - `src/server/db/repositories/excellent-remix-billing-repository.js` (`settleExcellentBillingRequest`)

---

### I2: 尝试身份（Reservation Token）不可变校验与迟到回调防御

- **问题根因**：原 `failExcellentBillingRequest` 收到回调时，盲目读取业务请求表的当前最新行，并优先采用 `request.task_key`。当 T1 失败重试建立 T2 新尝试后，若收到网络迟到的 T1 失败通知，函数错误使用了 T2 的 `task_key` 执行资金释放，导致正在执行的 T2 预占被提前释放，用户可用余额异常恢复。
- **修复方案**：
  1. 释放资金前严格校验 `reservationToken`。若缺失或为空，拒绝根据业务请求推测键值，直接返回 `STALE_BILLING_ATTEMPT`。
  2. 回调操作的尝试预占键由传入的 `reservationToken` 确定：`excellent_${kind}:${userId}:${requestId}:${reservationToken}`。
  3. 若业务请求的 `created_at` 不等于传入的 `reservationToken`，判定为迟到/过时回调：仅核对旧尝试自身的预占记录（若为终态则幂等忽略，若仍有孤立残留仅释放旧尝试），绝不触碰当前活跃请求及其 T2 预占。
  4. 若当前请求已处于 `completed` 终态，迟到失败回调无副作用直接忽略。
- **涉及文件**：
  - `src/server/db/repositories/excellent-remix-billing-repository.js` (`failExcellentBillingRequest`)

---

### I3: 历史尝试独立身份保留与 V18 改键唯一冲突消除

- **问题根因**：原 V18 迁移在规范化 `task_credit_reservations` 中 `excellent_*` 记录时，遍历每一条历史预占行，并使用当前业务请求行的最新 `created_at` 重建 `task_key`。如果同一用户对同一请求发生过多次尝试（例如 T1 释放、T2 重试）且落在同一批次上，V18 会将 T1 和 T2 的 `task_key` 重写为相同字符串，直接触发 `UNIQUE(task_key, lot_id)` 约束冲突导致迁移回滚。
- **修复方案**：
  1. **已规范键跳过**：若 `task_key` 已具备四段式完整时间戳身份（`excellent_{kind}:{userId}:{requestId}:{token}`），原样保留，不再重写。
  2. **历史终态记录独立性**：对于旧版本三段式记录，若状态为 `released` 或 `settled`，采用该预占行自身的 `created_at` 生成独立键，与当前尝试物理隔离。
  3. **写入前防重保障**：更新前检查 `(canonicalKey, lot_id)` 是否已存在其他行，若冲突则标记 `audit_required`，绝不因唯一约束阻断数据库升级。
  4. **已执行 V18 修复（V19）**：追加增量迁移 V19，扫描因旧 V18 误重写为当前请求时间的历史 released/settled 行，并还原其真实历史尝试时间戳。
- **涉及文件**：
  - `src/server/db/migrations.js` (Migration 18 前置防冲突保护 + Migration 19 增量修复)

---

### I4: 订阅快照严格沿真实成交与升级链路重建 (I4a & I4b)

- **问题根因**：
  - **I4a**：原 V18 通过 `payment_orders WHERE user_id = ? ORDER BY id DESC LIMIT 1` 获取订单快照。若当前用户持有 Pro 月付套餐，同时已提前付款购买了下月生效的 Business 套餐安排（`subscription_schedules`），V18 错误拾取了未来的 1500 分订单回填给当前 400 分 Pro 订阅。
  - **I4b**：原 V18 对年付订阅取 `subscription_grants WHERE subscription_id = ? ORDER BY period_index ASC LIMIT 1`。若用户中途升级，第一期实际发放 100 分，后续期数已提升至 400 分，V18 错误取第一期的 100 分回填为当前订阅的完整月度额度，导致后续升级业务版时差额按 1500 - 100 计算。
- **修复方案**：
  1. 引入独立快照重建模块 `src/server/billing/snapshot-recovery.js` (`reconstructSubscriptionSnapshot`)。
  2. 严格按 `credit_lots WHERE subscription_id = ?` 溯源开通订单（`source_type = 'cycle'`）与升级订单（`source_type = 'upgrade'`）。开通订单固化原始额度，升级订单链条获取当前完整额度。
  3. 年付订阅检查当前期数与末期 grant：`SELECT credits FROM subscription_grants WHERE subscription_id = ? ORDER BY period_index DESC LIMIT 1`，准确反映已升级至 400 分的月度权益，同时保留历史第一期发放为 100 分。
  4. 绝不以最新未关联订单覆盖当前订阅，未关联的排期订单保留在 `subscription_schedules` 中。
  5. 无法唯一重建的订阅标记为 `audit_required`，报价系统明确阻断并抛出核查异常，禁止退回当前目录或硬编码猜分。
- **涉及文件**：
  - `src/server/billing/snapshot-recovery.js` (新增快照追溯模块)
  - `src/server/billing/quote-service.js` (`getSubscriptionSnapshot`, `createQuote`)
  - `src/server/db/migrations.js` (Migration 18 快照回填逻辑修复 + Migration 19 全量核对与修复)
  - `scripts/audit-and-repair-billing-v2.js` (追加第 5 部分订阅快照审计清单)
