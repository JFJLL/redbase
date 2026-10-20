# RedBase 全仓积分与余额写入链路审计报告

本审计报告覆盖当前仓库内所有涉及用户积分余额写入、预占、结算、退回、管理员调整和流水记录的调用链路，核验“批次账本为唯一事实源，`users.credits` 仅为派生兼容缓存”的闭环一致性。

---

## 1. 唯一事实源原则与设计规范

在本次定向整改中，系统严格落实了以下约束：

1. **唯一事实源 (`credit_lots` + `credit_lot_allocations`)**：
   - 所有的有效积分必须存在于 `credit_lots` 批次中。
   - 所有已生效扣费必须有 `credit_lot_allocations` 逐笔记录。
   - `users.credits` 只能通过 `syncUserCreditsCache(userId)` 派生更新，绝对禁止任何业务仓库绕过批次直接对 `users.credits` 进行 `UPDATE users SET credits = credits - ?`。
2. **前置开账防覆盖 (`migrateLegacyUserCredits`)**：
   - 在任何写入批次的操作（购买、充值、管理员加分、注册、扣分前），若用户存在未迁移的旧余额（`legacy_credits_migrated = 0`），必须先原子结转为永久保留批次，再执行新批次写入。
3. **事务强一致性与禁止空 catch**：
   - 校验可用额度、插入流水事件、扣减批次、记录分配在同一事务内完成；余额不足或异常时必须完整抛错并回滚，禁止返回虚假 `spent: true`。

---

## 2. 真实业务写入路径审计清单

### 路径 1：热点趋势分析 (`trend-analysis-repository.js`)
- **入口函数**：`completeTrendAnalysisRequest`
- **原代码缺陷**：直接执行 `UPDATE users SET credits = credits - ?`，未写批次扣减，导致读钱包时余额重算复原（审查缺陷 R1）。
- **整改实现**：
  - 移除了所有直接写 `users.credits` 的 SQL。
  - 在生成有效分析后，原子插入 `credit_events` 并调用 `spendCreditsFromLots`。
  - 生成对应的 `credit_lot_allocations` 记录，随后由 `syncUserCreditsCache` 派生更新 `users.credits`。
- **验证结论**：通过 `tests/credits/billing-v2-remediation.test.js` (R1)，消费后读钱包、重启、查后台均保持 99 分，分配数严格为 1。

### 路径 2：通用扣费事务 (`admin-repository.js`)
- **入口函数**：`spendCreditsWithEventInTransaction` / `trySpendCreditsWithEvent`
- **原代码缺陷**：先扣 `users.credits`，再在 `try-catch` 中尝试扣批次并吞掉异常，返回 `spent: true`（审查缺陷 R2）。
- **整改实现**：
  - 移除了直接更新 `users.credits` 的语句和空 catch 块。
  - 前置检查 `getUserWalletBalances` 与未决任务预占量（趋势分析、优秀内容、视频项目），若不可用余额不足立即返回 `spent: false`。
  - 插入 `credit_events` 后原子执行 `spendCreditsFromLots`，若抛错则事务完整回滚。
- **验证结论**：通过 `tests/credits/billing-v2-remediation.test.js` (R2)，过期缓存不会被扣成伪成功，余额为 0 且回滚完整。

### 路径 3：优秀内容与二次创作 (`excellent-remix-billing-repository.js`)
- **入口函数**：`settleExcellentBillingRequest`
- **原代码缺陷**：在收费模式下直接使用 SQL 更新 `users.credits`，未进入批次账本。
- **整改实现**：
  - 收费结账统一接入 `spendCreditsFromLots` 与 `syncUserCreditsCache`。
  - 扣除失败时标记请求 `status = 'failed'` 并抛出 `INSUFFICIENT_CREDITS`。
- **验证结论**：通过 `tests/credits/excellent-remix-billing.test.js` 全量 14 项用例，计费与窗口滑动逻辑完全正常。

### 路径 4：视频项目生成与重试 (`video-project-repository.js`, `video-script-billing-repository.js`)
- **入口函数**：`createProject`、`retryClip`、`startVideoScript`
- **接入方式**：统一调用 `spendCreditsWithEventInTransaction`，自动享受原子批次扣减、防吞异常与派生缓存同步保护。
- **验证结论**：通过 `tests/video-generation-review.test.js` 全量 22 项用例。

### 路径 5：视频项目失败退款 (`video-billing.js`)
- **入口函数**：`refundVideoProjectReservation`
- **原代码缺陷**：直接调用 `updateUserCredits(user.id, credits + refundAmount)`，导致批次账本未恢复，重试再次扣款时因账本与缓存脱节多扣分。
- **整改实现**：
  - 查询原预占事件的 `credit_lot_allocations`，未过期批次直接恢复 `remaining_credits`；若原批次已过期或历史遗留，则创建限期 7 天的补偿批次。
  - 调用 `syncUserCreditsCache` 保持缓存同步。
- **验证结论**：通过 `tests/video-generation-review.test.js` (two early task-id submission failures refund two distinct reservations exactly once)，重试扣费与退款准确对齐到 1000 分。

### 路径 6：图片生成与图片编辑 (`image-generation-routes.js`, `image-jobs.js`)
- **入口函数**：`trySpendCreditsWithEvent`、`refundCreditEventIfNeeded`
- **整改实现**：
  - 扣款通过 `trySpendCreditsWithEvent` 走统一批次账本。
  - 退款通过 `refundCreditEventIfNeeded` 恢复对应批次（未过期恢复原批次，已过期补偿 7 天）。
- **验证结论**：通过 `tests/api/image-job-recovery.test.js` 全量 14 项用例。

### 路径 7：新用户注册初始积分 (`auth-repository.js`)
- **入口函数**：`insertUser`
- **整改实现**：插入新用户若携带初始赠分（如 50 分），在同一流程中为用户建立 `legacy_credits_migrated = 0`，首笔业务发生或读取时自动入账为永久保留积分。
- **验证结论**：通过 `tests/credits/billing-v2-remediation.test.js` (R10) 及注册赠分断言。

### 路径 8：管理员手动加减积分 (`admin-repository.js`)
- **入口函数**：`addCredits`
- **整改实现**：
  - 增加积分时前置执行 `migrateLegacyUserCredits`，创建 `grant` 类型的永久批次并插入审计事件。
  - 扣减积分时通过 `spendCreditsFromLots` 执行批次扣除。
- **验证结论**：加分后读钱包不会丢失用户已有旧余额，加减流水均可追溯。

### 路径 9：支付履约结算 (`payment-repository.js`)
- **入口函数**：`settlePaidPaymentOrder`
- **整改实现**：
  - 支付状态置为 `paid` 后，调用 `fulfillPaymentOrder`。
  - 仅当履约状态为 `fulfilled` 时记录正向积分流水（加油包记 `topup_purchase`、套餐首期记 `cycle_first_grant`、升级补发记 `upgrade_grant`）。
  - 若为 `scheduled`（待生效）或 `audit_required`（待核查），不记录虚假入账流水。
- **验证结论**：通过支付路由全套回归及待核查订单测试。

---

## 3. 审计结论

全仓已无任何裸写 `UPDATE users SET credits` 的旁路。所有积分变动（开账、发放、升级补发、加油包、消费、预占、释放、退回、到期、补偿）均由 `credit_lots` 及 `credit_lot_allocations` 驱动，满足金融级唯一事实源与对账要求。