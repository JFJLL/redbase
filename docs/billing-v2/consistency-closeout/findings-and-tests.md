# 根因分析与 H1—H8 回归测试对照表 (Findings & Tests Matrix)

## 一、四组共同根因收口情况

### A 组：优秀内容计费接入新预占体系
- **A1（结算多余余额检查）**：`settleExcellentBillingRequest` 原逻辑检查 `user.credits < cost`，但在预占扣除后自由余额已是 0，导致 1 分用户被误判积分不足。已移除自由余额检查，改为严格核销 `task_credit_reservations` 中的合法预占。
- **A2（可用余额双重冻结）**：`reserveExcellentBillingRequest` 从自由余额 `wallet.totalAvailable` 中再次扣减 `sumReservedExcellentBillingCredits`，导致已预占批次被二次扣减。已重构为仅扣减未迁入 `task_credit_reservations` 的历史遗留请求。
- **A3（事务内吞掉预占错误）**：原逻辑在 `reserveCreditsForTask` 发生 DB 异常时捕获并伪装为 `insufficient`，导致外层事务提交部分批次。已移除异常捕获，确保 DB 错误立即回滚外层事务并原样抛出。
- **A4（优秀内容任务 key 匹配不一致）**：原趋势仓库查询 `unmigratedExcellent` 时仅匹配不带时间戳的前缀，与优秀内容任务 key 不一致。已统一通过新增持久化列 `task_key` 实现全链路精确外键级关联。

### B 组：迁移恢复可继续使用的业务身份
- **B1（V16/V17 遗留非规范键）**：V16 生成 `trend_analysis:<userId>:<requestId>`，V17 仅对空键尝试恢复，导致旧键原样迁入且无法被新结算逻辑找到。在 V18 增量迁移中，显式按 `(user_id, task_id)` 反查唯一对应的 `(brand_id, bucket_key)`，彻底重构为完整规范键 `trend_analysis:<userId>:<brandId>:<bucketKey>:<requestId>`。
- **B2（移除宽泛 legacyReq 旁路）**：彻底移除了 `completeTrendAnalysisRequest` 中当结算未找到时直接调用 `spendCreditsFromLots`（fresh spend）的错误旁路，强制要求任务通过合法预占结算。

### C 组：成交快照由正式业务创建与维护
- **C1（快照持久化断层）**：开通、排期激活和升级逻辑原先未向 `subscriptions.snapshot_json` 写入成交快照，导致后续升级回退到当前目录 `oldPlan.credits`。已在 `fulfillPaymentOrder` 和 `advanceSubscriptionLifecycles` 完整写入成交权益快照，并在 `quote-service.js` 引入回填回溯机制，目录改价或额度变动绝不影响已购权益。

### D 组：付款时间与积分所属周期对齐
- **D1（跨期升级权益追补）**：升级订单若在原期内付款，但因通知延迟在系统推进至新期后才履约，原期补发不延长到新期；当前新期自动通过 `cycle` 批次追补目标套餐与已发旧额度之间的差额（如 1500 - 400 = 1100），后续各期自动拉平为目标套餐额度，绝不返回 401 错误权益。
- **D2（付款时间晚于原期拦截）**：若付款时间晚于原报价周期到期时间，标记为 `audit_required`，拒绝非法延长已过期服务。

---

## 二、H1—H8 回归用例对照表

| 用例编号 | 场景描述 | 输入条件 | 预期输出与断言 | 实际执行结果 | 对应测试位置 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **H1** | 用户仅 1 分，执行收费 1 分的优秀内容融合任务 | 用户初始 1 分，发起 1 分 fusion 任务，模型成功并结算 | 自由余额 0、预占 0、已用 1；请求 completed；不得抛 INSUFFICIENT_CREDITS | **PASS** | `billing-v2-consistency-closeout.test.js` |
| **H2** | 用户有 2 分，并发/顺序预占与超额拦截 | 用户初始 2 分，前两个 1 分任务预占，第三个 1 分任务尝试预占 | 任务 1、2 状态 reserved，任务 3 状态 insufficient；任务 1、2 结算后已用 2、冻结 0、可用 0 | **PASS** | `billing-v2-consistency-closeout.test.js` |
| **H3** | 预占批次冻结后，插入预占记录时注入 DB 错误 | 用户有 10 分，通过 SQLite 触发器注入底层写入故障 | 事务完整回滚，抛出真实 DB 错误，外部模型调用为 0，可用仍为 10，冻结为 0，无孤立脏数据 | **PASS** | `billing-v2-consistency-closeout.test.js` |
| **H4** | 交叉业务预占防重（优秀内容 -> 趋势任务） | 用户有 2 分，优秀内容任务预占 1 分（含时间戳），趋势任务预占 1 分 | 趋势任务成功预占，可用 0、冻结 2；优秀内容预占绝不被趋势二次扣减 | **PASS** | `billing-v2-consistency-closeout.test.js` |
| **H5** | V15 在途任务升级至 V18 后结算原任务 | V15 在途任务（可用 9，冻结 1），经 V16/V17/V18 迁移后完成原任务 | 可用保持 9、冻结 0、已用 1，结算原批次；绝不误扣变成可用 8 | **PASS** | `billing-v2-consistency-closeout.test.js` |
| **H6** | V15 在途任务升级至 V18 后失败释放 | V15 在途任务（可用 9，冻结 1），经 V18 迁移后失败 | 可用恢复为 10、冻结 0、已用 0；任务标记 failed | **PASS** | `billing-v2-consistency-closeout.test.js` |
| **H7** | 目录修改不改变已购快照（400 改为 900 升级算例） | 正式购买 Pro 月付（400 分），目录修改 Pro 额度为 900，剩余 7/30 天升级 Business (1500) | 升级补发 `ceil((1500 - 400) * 7 / 30) = 257` 分，绝对不是 140 分 | **PASS** | `billing-v2-consistency-closeout.test.js` |
| **H8** | 年付升级跨期延迟履约（先调度发旧期，后回调升级） | Pro 年付（400/月），第一期末前 1 秒支付 Business 升级单；第二期已调度发 400 分后处理升级回调 | 原期补发不延期；第二期追补 1100 分达到 1500 分，后续期全为 1500 分，订单 fulfilled，绝不残留 401 分 | **PASS** | `billing-v2-consistency-closeout.test.js` |
