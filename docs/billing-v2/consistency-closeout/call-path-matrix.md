# 全链路资金与收费业务调用矩阵 (Call Path Matrix)

## 一、收费业务与共同资金接口调用链

| 业务模块 | 预占接口 (Reservation) | 预占身份格式 (Canonical task_key) | 结算接口 (Settlement) | 释放接口 (Release) | 超时清理 (Stale Expiry) | 自由余额扣除口径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **优秀内容 (方向)** | `reserveExcellentBillingRequest` -> `reserveCreditsForTask` | `excellent_direction:<userId>:<requestId>:<createdAt>` | `settleCreditsForTask` (仅按 task_key 结算) | `releaseCreditsForTask` | `expireStaleExcellentBillingReservations` (释放原批次) | `wallet.totalAvailable - unmigrated` (消除双重扣除) |
| **优秀内容 (融合)** | `reserveExcellentBillingRequest` -> `reserveCreditsForTask` | `excellent_fusion:<userId>:<requestId>:<createdAt>` | `settleCreditsForTask` (仅按 task_key 结算) | `releaseCreditsForTask` | `expireStaleExcellentBillingReservations` (释放原批次) | `wallet.totalAvailable - unmigrated` (消除双重扣除) |
| **趋势分析** | `reserveTrendAnalysisRequest` -> `reserveCreditsForTask` | `trend_analysis:<userId>:<brandId>:<bucketKey>:<requestId>` | `settleCreditsForTask` (严格核对行数，删除 legacy 旁路) | `releaseCreditsForTask` | `expireStaleReservations` | `wallet.totalAvailable - unmigrated` |
| **视频项目 (D2/G2)** | `reserveCreditsForTask` | `video_project:<userId>:<projectId>:<clipIndex>` | `settleCreditsForTask` | `releaseCreditsForTask` | 状态机自动恢复与退款重试 | `wallet.totalAvailable` |
| **视频脚本** | `spendCreditsWithEventInTransaction` (直接消费或预占) | `video_script:<userId>:<requestId>` | 随生成落库原子扣除 | 失败事件全额退还 | 会话超时保护 | `wallet.totalAvailable - unmigrated` |
| **生图 / 组图 / 改图**| `trySpendCreditsWithEvent` | `image_job:<userId>:<jobId>` | 扣减并记录 credit_events | 失败退还 credit_events | 定时扫描 | `wallet.totalAvailable - unmigrated` |
| **管理员调整** | `spendCreditsWithEventInTransaction` | `admin_adjust:<adminId>:<userId>:<eventId>` | 事务原子操作 | 不适用 | 不适用 | `wallet.totalAvailable - unmigrated` |

---

## 二、购买、履约与周期调度调用链

1. **服务端报价 (`src/server/billing/quote-service.js`)**
   - 依赖入口：`createQuote({ userId, kind, itemId, cycle, nowMs })`
   - 快照提取：调用 `getSubscriptionSnapshot(activeSub, db)`，严格从 `subscriptions.snapshot_json` 读取用户购买时的月度额度 `monthlyCredits`，彻底杜绝回退到动态目录 `PLANS[].credits`。
   - 升级补款：按剩余服务期与剩余积分期比例精确计算补款与增量额度，保留累积浮点数 `cumExact` 与向上取整 `cumCeil`。

2. **订单创建与原子锁 (`src/server/db/repositories/payment-repository.js`)**
   - 依赖入口：`insertPaymentOrder({ outTradeNo, userId, idempotencyKey, plan, quote, acquireLock: true })`
   - 契约统一：通过 `buildCanonicalOrderSnapshot(quote, plan)` 生成不可变快照，写入 `payment_orders.snapshot_json`、`anchor_day`、`issued_now`、`original_period_start`、`original_period_end`、`target_monthly_credits`。
   - 账户并发锁：`account_plan_order_locks` 互斥保护进行中与待生效订单。

3. **支付确认与收款落地 (`src/server/db/repositories/payment-repository.js`)**
   - 依赖入口：`settlePaidPaymentOrder({ outTradeNo, tradeNo, paidAt, nowIso })`
   - 两阶段保障：优先持久化收款事实（`status = 'paid'`），履约异常时保留付款记录并标记 `audit_required`，绝不回滚已收资金。

4. **订单履约与恢复 (`src/server/billing/subscription-service.js`)**
   - 依赖入口：`fulfillPaymentOrder(order, nowMs, db)`
   - 新开通 (`activate`)：插入 `subscriptions` 时完整持久化 `snapshot_json`（含 `monthlyCredits`, `pricingBasisFen`, `anchorDay`）。
   - 续费/降档 (`schedule`)：插入 `subscription_schedules` 时持久化 `snapshot_json`。
   - 升级 (`upgrade`)：
     * 若真实付款时间晚于原期结束时间，标记 `audit_required`（拒绝过期报价）。
     * 若付款在原期内但在推进后才履约，原期增量归属于原期（到期不延期），当前新期通过 `cycle` 批次追补差额到目标套餐额度（例如 400 追补 1100 至 1500），年付后续待发放期全量更新为目标额度。
     * 原子更新 `subscriptions.snapshot_json`。

5. **生命周期调度 (`src/server/billing/subscription-service.js`)**
   - 依赖入口：`advanceSubscriptionLifecycles(nowMs, db)`
   - 排期激活：将 `subscription_schedules` 转换为 `active` 订阅，同时将 `schedule.snapshot_json` 贯穿写入 `subscriptions.snapshot_json`。
   - 年付分期：多进程 CAS 认领 `pending` 分期，幂等发放当期额度并记录 `cycle_grant` 流水。
