# 套餐与积分 V2 事务边界与资金守恒不变式审计报告

本审计文档总结 RedBase 套餐与积分 V2 在本轮整改后确立的核心资金安全机制与不可破坏的不变式（Invariants）。

## 1. 唯一可用余额口径与派生缓存定义

在批次体系（Credit Lots）下：
- **唯一可用余额公式**：
  totalAvailable = sum(remaining_credits - reserved_credits) for all active, unexpired lots
- **用户表缓存属性**：
  users.credits 仅为派生只读缓存，由 syncUserCreditsCache(uid, db) 统一从批次求和派生。
- **杜绝双重冻结**：
  批次预占 (reserved_credits) 增加时，可用余额已即时扣除。业务请求表 (trend_analysis_requests, excellent_remix_billing_requests) 的待处理记录不得再次在可用余额上执行扣减，防止同一笔预占被扣算两次。

## 2. 任务身份与账户归属隔离

在多任务并发、跨租户与跨品牌场景中，建立规范化任务标识：
- **规范身份键**：
  - 趋势分析：trend_analysis:userId:brandId:bucketKey:requestId
  - 优秀内容：excellent_kind:userId:requestId
  - 通用任务：taskType:userId:taskId
- **归属核验**：
  - 结算与释放时，严格核对任务记录的 user_id 与关联批次的 user_id。
  - 批次扣减记录在 credit_lot_allocations 中严格与操作人一致，彻底杜绝跨账户误扣与跨任务错配。
- **终态保护与幂等**：
  - 处于 settled（已结算）状态的预占记录绝对不可被重新预占。
  - 处于 released（已释放）状态的记录已归还额度，如发起新尝试则创建全新预占，严禁复活旧记录。
  - 移除结算无预占时的危险 fresh spend 补扣兜底，异常时直接拒绝并报警。

## 3. 到期、释放与流水数量守恒定律

针对生命周期与任务预占跨越到期时刻的场景：
- **批次守恒方程**：
  initial_credits = remaining_credits + used_credits + expired_credits
- **跨期释放规则**：
  当持有预占的任务在批次到期后发生失败或释放时，被释放的积分不得重新回到可用余额，必须同事务直接核销扣减 remaining_credits 并记录 cycle_expire 流水。
- **守恒算例**：
  - 初始 50 分周期批次：A 预占 20，B 预占 10，未预占 20。
  - 到期时：未预占 20 失效（流水 -20，批次剩余扣减至 30）。
  - A 任务释放：20 分过期失效（流水 -20，批次剩余扣减至 10）。
  - B 任务结算：10 分消费（流水 -10，批次已用 +10，剩余扣减至 0）。
  - 最终状态：到期 40 + 消费 10 = 50，数量严格守恒，杜绝重复到期与凭空增发。

## 4. 两阶段安全结算：收款确认与履约隔离

针对三方支付异步通知与对账机制：
- **阶段一：收款事实可靠持久化（Transaction 1）**
  - 在接收到三方渠道（支付宝/微信支付）签名验签合格的通知或主动查单结果后，首先在独立事务中将订单置为 status = 'paid'，并持久化真实交易号 trade_no 与渠道付款时间 paid_at。
- **阶段二：独立幂等可恢复履约（Transaction 2）**
  - 在阶段一提交后，发起独立事务执行权益发放 (fulfillPaymentOrder)。
  - 若履约因数据库锁或逻辑异常失败，绝不回滚阶段一已确认的收款事实，订单安全置为 fulfillment_status = 'unfulfilled'。
  - 后续重复通知、定时对账扫单或系统重启恢复统一重试阶段二，达成最终一致。

## 5. 跨进程调度幂等与并发互斥

- **调度分期发放**：
  advanceSubscriptionLifecycles 在短事务内执行原子条件领取：
  UPDATE subscription_grants SET status = 'granting' WHERE id = ? AND status = 'pending'
  配合 credit_lots.grant_id 唯一索引约束，多进程并发下每个分期在物理层面仅能且只会生成 1 个批次和 1 次流水。
- **套餐下单账户级互斥**：
  通过 account_plan_order_locks 表的 user_id PRIMARY KEY 约束，在引擎层保证同一账户同一时间最多存在 1 个未终态的套餐变更订单，杜绝跨进程或支付宝/微信多渠道绕过互斥重复购买。
