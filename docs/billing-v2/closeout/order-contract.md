# RedBase 套餐与积分 V2 唯一订单与权益快照契约规范

## 1. 契约背景与设计原则

为消除报价、订单落库、读回映射、支付结算、权益履约、排期激活及年付分期之间的字段断层，工程统一采用单一权威的 `order.snapshot`（在代码中兼容映射为 `order.quote`）结构。该契约彻底杜绝在履约时重新读取当前商品目录默认值（`plan.credits`）的旁路，实现“以成交快照为唯一事实源”。

---

## 2. 核心字段定义与语义区分

| 快照字段 | 数据类型 | 业务语义与取值依据 | 与易混淆字段的明确区分 |
| :--- | :--- | :--- | :--- |
| `monthlyCredits` | `number` | **套餐每期标准月度额度**。业务版=1500，专业版=400，轻量版=100，加油包=0。 | 绝不同于 `issuedNow`。无论续费（即时为0）或升级（即时为增量），月度额度始终记录 1500/400。 |
| `issuedNow` | `number` | **本次订单付款后即时发放积分**。开通=月度额度；升级算例=257；续费/降档/切周期=0。 | 续费时合法为 0，不能被 `\|\|` 误判为假值而回退到目录默认值。 |
| `topupCredits` | `number` | **永久加油包额度**。小额=25，标准=80，大额=300。周期套餐为 0。 | 永久有效，不进月度分期，不设到期日。 |
| `amountFen` | `number` | **本笔订单实际应收金额（单位：分）**。升级算例=46667分 (¥466.67)。 | 不同于整期全价，为折算剩余时长后的实付应收值。 |
| `pricingBasisFen` | `number` | **目标套餐的计价基准全额（单位：分）**。用于未来二次升级补差价的基数。 | 记录全款价格（如业务版¥2,999.00/月），避免拿折算后的实付金额做二次升级基数。 |
| `targetMonthlyCredits`| `number` | **年付升级后未发各期的目标额度**。升级业务版后未发的5期均为 1500。 | 绝不能写成当期增量 257。确保未来到期推进准确发放 1500 分。 |
| `cumExact` | `number` | **本期升级的高精度累计值**。例如 31 天剩 3 天连续升级，精准传递 29.032258 + 106.451612 = 135.48387。 | 真实订单持久化并在每次升级读回，杜绝每次独立取整导致的多发/少发。 |
| `cumCeil` | `number` | `Math.ceil(cumExact)`，本期累计应发整数。 | 本次增量 `issuedNow = cumCeil - previousIssued`。 |
| `anchorDay` | `number` | **日历月末锚点**。1/31开通记录31，2/28激活时继承31，使3月服务与积分精准在3/31到期。 | 解决二月平年闰年截断后丢失月末锚点的缺陷。 |
| `originalSubscriptionId` | `number` | 目标升级/续费的原有效订阅 ID。 | 履约前置校验，原订阅已失效或已变更则拒绝应用。 |
| `originalPlanId` | `string` | 生成报价时当前订阅的档位代码（如 `pro`）。 | 防止两笔并发升级单在第一笔生效后第二笔仍重复补发。 |

---

## 3. 全链路调用规范与数据流转

```
[前端客户端 / 购买意图]
        │  POST /api/billing/quote (userId, itemId, cycle)
        ▼
[QuoteService: createQuote] ── 准确计算并冻结 cumExact / targetMonthlyCredits / issuedNow
        │
        │  POST /api/payments/{provider}/orders (quoteId, idempotencyKey)
        ▼
[PaymentRoutes: 下单路由]
        ├─ 1. 渠道可用性预检 (enabled && gateway != null，否则503)
        ├─ 2. 幂等订单查询 (已有订单重放返回同一订单，参数冲突返回409)
        ├─ 3. 新售规则校验 (关闭直接传 planId 购买旧 SKU 入口)
        ├─ 4. 账户级套餐变更占位 (已有未完成 created/pending 套餐订单互斥返回409)
        └─ 5. 原子事务消费报价与落库:
                verifyAndConsumeQuote ──► 校验原订阅状态并打上 used_at 标记
                insertPaymentOrder    ──► buildCanonicalOrderSnapshot 写入 payment_orders.snapshot_json
        │
        │  渠道支付成功异步通知 / 主动查单对账
        ▼
[PaymentRepository: settlePaidPaymentOrder]
        ├─ 更新 payment_orders.status = 'paid' (即使已paid且unfulfilled也能可恢复重放)
        ├─ 读回 canonical order.snapshot
        └─ 调用 fulfillPaymentOrder(order, nowMs, db)
                │
                ▼
[SubscriptionService: fulfillPaymentOrder]
        ├─ Topup: 创建永久批次 credit_lots(expires_at=null)，更新订单 fulfilled
        ├─ Activate: 校验无 active 订阅，创建 subscriptions 表记录及当期/年付分期，发放首期
        ├─ Upgrade: 校验 expectedPlanId 与 activeSub 一致 (不一致安全进入 audit_required)
        │           更新 subscriptions.upgrade_cumulative_exact = snapshot.cumExact
        │           若为年付，将未发 grants.credits 全部原子更新为 snapshot.targetMonthlyCredits (1500)
        │           按 snapshot.issuedNow 创建 upgrade 批次，更新订单 fulfilled
        └─ Renew/Schedule: 按 snapshot.monthlyCredits (400) 写入 subscription_schedules 表
                           更新订单 fulfillment_status = 'scheduled'
        │
        │  日历推进 / 定时调度 / 服务重启补扫
        ▼
[SubscriptionService: advanceSubscriptionLifecycles]
        ├─ 激活到期排期: 创建新服务、创建新批次、同事务生成 credit_events(cycle_grant) 发放事实
        │               更新排期 activated，更新对应订单 fulfilled
        └─ 推进年付分期: 发放当期 grants，同事务重置 upgrade_cumulative_exact=0 与 increment=0
```
