# RedBase 全业务计费与资金路径深度审计报告

## 1. 资金架构与单一事实源原则

本系统所有积分资金的唯一事实源为 **积分批次账本 (`credit_lots`)** 与 **批次核销分配 (`credit_lot_allocations`)**。
用户表 `users.credits` 仅为派生只读缓存，由 `syncUserCreditsCache(uid, db)` 统一从可用批次求和派生。全工程严禁出现直接写 `UPDATE users SET credits = credits - ?` 的旁路。

---

## 2. 真实收费业务路径逐条审计

### 2.1 趋势分析 (Trend Analysis)
- **代码位置**：`src/server/db/repositories/trend-analysis-repository.js`
- **预占入口**：`reserveTrendAnalysisRequest`
  - 校验用户可用余额。
  - 调用 `reserveCreditsForTask({ userId, taskId: requestId, taskType: 'trend_analysis', amount: cost })`。
  - 严格按 FIFO 锁定批次可用额度，并持久化到 `task_credit_reservations` 表。
- **结算入口**：`completeTrendAnalysisRequest`
  - 任务成功时，调用 `settleCreditsForTask({ userId, taskId: requestId, creditEventId })`。
  - **跨期保护 (N7)**：即便任务执行期间原周期批次已跨过到期时间，结算依然精准从被预占锁定的原批次扣除并记录 `credit_lot_allocations`，绝不发生回退 fresh spend 误扣永久积分。
- **失败与超时释放**：`failTrendAnalysisRequest` 与 `expireStaleReservations`
  - 任务失败或 20 分钟超时清理时，调用 `releaseCreditsForTask({ userId, taskId: requestId })`。
  - 若原批次在持有预占期间已到期，释放后该部分额度同事务作为失效过期处理并记录 `cycle_expire` 流水，不复活成可用积分。

### 2.2 优秀内容与融合创作 (Excellent Remix & Fusion)
- **代码位置**：`src/server/db/repositories/excellent-remix-billing-repository.js`
- **预占入口**：`reserveExcellentBillingRequest`
  - 检查 5 分钟滑动窗口免费次数（前 3 次免费）。
  - 若需计费（第 4 次或融合方案），调用 `reserveCreditsForTask`，将批次分配与任务 ID 绑定。
- **结算与释放**：`settleExcellentBillingRequest` / `failExcellentBillingRequest`
  - 模型生成成功时结算原预占；失败或降级为免费结果时同事务安全释放预占额度。
  - 具备防余额被外部抽干的防御检查。

### 2.3 视频脚本与项目渲染 (Video Script & Video Projects)
- **代码位置**：`src/server/db/repositories/video-script-billing-repository.js`、`src/server/video/video-billing.js`
- **脚本计费**：`beginVideoScriptRequest`
  - 采用事务内原子扣除 `spendCreditsWithEventInTransaction`，失败自动回滚。
- **视频项目与片段退款**：`refundVideoCredits`
  - 针对外部未执行或生成失败片段，按精确比例补偿结转，同事务更新批次与流水，具备 `findRefundEvent` 幂等防重保障。

### 2.4 图文内容与图片生成 (Image Generation)
- **代码位置**：`src/server/ai/image-jobs.js`、`src/server/db/repositories/admin-repository.js`
- **扣费机制**：统一调用 `trySpendCreditsWithEvent`。
  - 内部基于 `spendCreditsFromLots` 执行 FIFO 扣除，同步写入 `credit_lot_allocations` 与不可变 `credit_events`。
  - 余额不足时抛出明确异常并完整回滚，禁止启动外部大模型调用。

### 2.5 管理员后台扣减与调整 (Admin Adjustments)
- **代码位置**：`src/server/db/repositories/admin-repository.js`
- **合规审计**：
  - 历史直接 `UPDATE users SET credits = credits - ?` 的空 catch 代码已被彻底移除。
  - 后台扣分必须通过 `spendCreditsWithEventInTransaction`，由批次账本驱动并写入审计员信息。
  - 后台加分通过 `createCreditLot` 作为永久积分或管理员赠送批次入账。

---

## 3. 统计口径与到期隔离审计

- **统计口径修正 (N8, E7)**：
  - `admin-repository.js` 中的 `readAdminOverviewStats` 与 `listAdminUserMetrics` 修复为：
    `SUM(CASE WHEN credit_delta < 0 AND action_type NOT LIKE '%expire%' THEN ...)`
  - **重要原则**：积分到期 (`cycle_expire`) 属于权益有效期终结的自然消亡，绝不计入用户的“消费量”，流水筛选与后台统计均能正确隔离。
- **分页与导出保护**：
  - 接口支持服务端 `page` 与 `pageSize`，正确返回总条数 `total`。
  - 导出 CSV 对开头包含 `=`, `+`, `-`, `@` 的字符自动追加 `'` 转义，杜绝公式注入风险。
