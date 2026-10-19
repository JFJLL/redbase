# 套餐权益生命周期与成交快照规范 (Entitlement Lifecycle & Transaction Snapshot)

## 一、成交快照设计与字段契约

为了彻底杜绝“目录改价/改额度影响存量已购用户”以及“升级计算错误”，全链路确立以下字段契约：

```typescript
interface CanonicalSubscriptionSnapshot {
  version: "v2";
  planId: string;                     // 套餐商品标识（例如 "pro"）
  planName: string;                   // 套餐名称（例如 "专业版"）
  cycle: "monthly" | "annual";        // 付款周期
  monthlyCredits: number;             // 成交约定的每月完整额度（例如 400 或 1500）
  initialCredits: number;             // 首期实际发放额度（开通为完整额度，升级为增量补发）
  pricingBasisFen: number;            // 计价基础金额（分，例如专业年月付全额）
  actualPaidTotalFen: number;         // 累计实付总金额（分）
  anchorDay: number;                  // 原始日历锚点日（1-31，按上海时区计算）
  serviceStart: string;               // 服务起始时间 ISO
  serviceEnd: string;                 // 服务结束时间 ISO
}
```

---

## 二、生命周期各阶段快照流转

1. **报价阶段 (`createQuote`)**
   - 新购套餐：快照写入 `monthlyCredits = plan.credits`。
   - 升级套餐：通过 `getSubscriptionSnapshot(activeSub)` 严格从原订阅快照提取 `monthlyCredits`（即便目录中专业版被临时改成了 900，已购用户的 `oldPurchasedCredits` 依然固定为成交时的 400）。
   - 额度差额按剩余日历期比例精确计算：
     $$\text{exactIncrement} = (\text{targetPlan.credits} - \text{oldPurchasedCredits}) \times \frac{\text{periodRemainingMs}}{\text{periodTotalMs}}$$

2. **下单阶段 (`insertPaymentOrder`)**
   - 调用 `buildCanonicalOrderSnapshot` 将不可变快照存入 `payment_orders.snapshot_json`。
   - 同时锁定 `original_subscription_id`、`original_plan_id`、`original_period_start`、`original_period_end` 与 `target_monthly_credits`。

3. **开通与升级阶段 (`fulfillPaymentOrder`)**
   - 开通订单：在 `subscriptions` 插入新记录时，将成交快照序列化持久化到 `snapshot_json` 字段。
   - 升级订单：原子更新 `subscriptions.snapshot_json` 为目标套餐的完整月度额度与最新实付基础，后续周期与续费排期全量继承。

4. **排期激活阶段 (`advanceSubscriptionLifecycles`)**
   - 续费/降档排期到达 `start_at` 时，生命周期调度器读取 `schedule.snapshot_json`，将其无损写入新激活的 `subscriptions.snapshot_json`，确保续约权益不变。

---

## 三、跨周期延迟履约保障机制 (Group D / H8)

针对“付款时间在新期开始前，但支付通知因网络延迟在新期推进后才到达”的极端时序：

1. **原期补发不延期**：原期补发额度（如 1 分）仅归属于原期。由于原期在物理时间上已经结束，该额度记入对应原到期日（已过期），绝不后延至新期，更不变成永久积分。
2. **新期差额自动追补**：调度器因尚未感知升级，在新期首日按旧档（如 400 分）发放了本期额度。当延迟付款履约时，系统计算目标套餐额度与本期已发额度的差额：
   $$\text{deficit} = \text{targetMonthlyCredits} - \text{currentGrant.credits} = 1500 - 400 = 1100$$
   同事务内生成该 1100 积分的批次发放与 `cycle_grant` 流水，将当前期总额度补足至 1500，并将年付后续待发放月份全量更新为 1500。
3. **已付款待核查兜底**：若渠道实际付款时间晚于原期结束时间（即用户在原周期已结束后才完成支付），则禁止自动延长，订单标记为 `audit_required`（`付款时间已晚于原报价周期到期时间`），资金安全落库，转人工核查。
