# 套餐与积分 V2 快照来源判断与架构设计说明

## 一、J1—J3 缺陷深度根因分析

### 1. J1 根因：历史发放记录不等于当前完整权益
- **业务场景**：用户开通轻量版年付（100分/月），生命周期正常推进到第 12 期。在第 12 期初期，系统已发出该期基础额度 100 分（`subscription_grants.credits = 100`，`status = 'granted'`）。随后用户在第 12 期内付费升级至专业版（400分/月）。
- **生效事实**：升级订单正常履约（`fulfillment_status = 'fulfilled'`），用户补发当期差额，订阅档位变更为 `pro`，当前订阅快照记录 `monthlyCredits: 400`。由于已是最后一期，没有未来的 `pending` 分期可更新。
- **旧代码缺陷**：旧版 `snapshot-recovery.js` 在通过升级订单与批次识别出 400 分后，执行了针对年付的后置兜底逻辑：
  ```sql
  SELECT credits FROM subscription_grants WHERE subscription_id = ? ORDER BY period_index DESC LIMIT 1
  ```
  该语句返回了第 12 期的历史已发放 grant（100 分），直接将 `currentMonthlyCredits` 强制覆盖为 100！
- **次生灾害**：Migration 19 将此推断作为权威答案，误将健康的 `{"monthlyCredits": 400, "planId": "pro"}` 破坏改写为 `100`。用户后续再次升级业务版时，计费差额基础被错误按 100 分计算（quotaDiff = 1500 - 100 = 1400，应为 1100），造成重复收费。

### 2. J2 根因：已付款 (paid) 不等于权益已履约生效 (fulfilled)
- **业务场景**：用户持有正常的专业版月付（400分/月），随后提交了业务版（1500分）升级订单并完成了渠道支付。但在履约阶段，该订单因付款时间过期、权益冲突或人工核查要求而进入 `status = 'paid'`，`fulfillment_status = 'audit_required'`。
- **生效事实**：升级并未生效。收款事实已由系统记录留存，但订阅当前档位仍是 `pro`，用户当前每月权益仍是 400 分。
- **旧代码缺陷**：旧恢复逻辑仅按 `status = 'paid' AND order_action = 'upgrade'` 检索订单，未过滤 `fulfillment_status`。待核查的业务版订单被作为已生效升级采纳，当前权益被推断为 1500 分。
- **次生灾害**：Migration 19 将订阅快照覆盖为 `business / 1500`，但 `subscriptions.plan_id` 仍为 `pro`，产生致命的状态分裂。

### 3. J3 根因：同用户与时间先后不构成归属证明
- **业务场景**：同一用户在 2025 年购买过轻量版（100分），该服务已自然到期。2026 年该用户拥有另一份专业版服务（400分），但由于异常模拟或历史关联缺失，该订阅没有批次和订单直接关联，快照为空。
- **生效事实**：2025 年的旧订单属于已过期的轻量版订阅 A，与 2026 年的当前订阅 B 没有任何合法归属关系。订阅 B 的来源不可追溯，属于待核查数据。
- **旧代码缺陷**：旧恢复逻辑中包含危险的回退逻辑：
  ```sql
  SELECT * FROM payment_orders WHERE user_id = ? AND status = 'paid' AND order_kind = 'plan' AND order_action = 'activate' AND created_at <= ? ORDER BY id DESC LIMIT 1
  ```
  此查询仅凭“同一用户”且“创建时间早于当前服务开始”，便选出了 2025 年的旧订单，将 100 分强加给当前专业版订阅 B。

---

## 二、权益来源与生效判断的七大核心原则

1. **历史发放记录不等于当前完整权益**：
   - `subscription_grants` 中已发放的记录（`status = 'granted'`）是历史财务账务事实，代表过去该期发放的数值，绝不能倒流覆盖后续已履约生效的升档结果。
2. **已付款不等于权益已经履约生效**：
   - 渠道到账记录保留，但只有 `fulfillment_status = 'fulfilled'` 的订单才能改变订阅的有效套餐与额度。
   - `unfulfilled`、`processing`、`audit_required`、未生效的 `scheduled` 订单归入 `unfulfilledUpgrades` 证据链，不参与当前权益生效计算。
3. **同一用户、时间更早，不构成订阅归属证明**：
   - 严禁使用 `created_at <= sub.service_start` 盲目回溯历史订单。
   - 必须通过直接外键（`credit_lots.subscription_id`、`order.snapshot.subscriptionId`、`subscription_schedules.order_id`）或无歧义的激活履约记录确立来源。
4. **原本健康的成交快照不能被较弱的推断覆盖**：
   - 若订阅当前快照非空且与 `sub.plan_id`、`sub.cycle` 及目录版本一致，只有具备更强的已履约链证据时才允许修复。
5. **来源无法唯一证明时明确标记待核查**：
   - 当证据不足或存在多种冲突解释时，返回 `unresolved` 或 `conflict`，快照返回 `null`，拒绝凭空拼凑。
6. **只有完全解析且匹配当前状态时才允许自动回填**：
   - 自动写入前必须校验解析出的 `resolved.planId === sub.plan_id`。
   - 若解析结果与当前订阅档位存在冲突，拒绝自动覆盖，留待人工核对。
7. **分层清晰隔离**：
   - 当前完整月度套餐额度（`monthlyCredits`）、当期按比例补发（`issuedNow`）、实际可用钱包余额（`wallet.totalAvailable`）、历史实际发放（`grant.credits`）及未来待生效排期（`subscription_schedules`）各自独立，互不混淆。

---

## 三、结构化来源审计模型设计

`inspectSubscriptionSnapshot(sub, db)` 返回结构：

```typescript
interface SubscriptionInspectionResult {
  status: "resolved" | "unresolved" | "conflict";
  reason: string;
  snapshot: {
    version: "v2";
    planId: string;
    cycle: "monthly" | "annual";
    monthlyCredits: number;
    initialCredits: number;
    pricingBasisFen: number;
    actualPaidTotalFen: number;
    anchorDay: number;
    serviceStart: string;
    serviceEnd: string;
  } | null;
  evidence: {
    activationSource: {
      type: "cycle_lot" | "schedule" | "explicit_order" | "annual_grant";
      lotId?: number;
      orderId?: number;
      scheduleId?: number;
      grantId?: number;
      planId?: string;
      monthlyCredits?: number;
    } | null;
    effectiveUpgrades: Array<{
      orderId: number;
      planId: string;
      targetMonthlyCredits: number;
      pricingBasisFen: number;
      fulfilledAt: string;
    }>;
    unfulfilledUpgrades: Array<{
      orderId: number;
      planId: string;
      targetMonthlyCredits: number;
      fulfillmentStatus: string;
    }>;
    grantsSummary: { count: number } | null;
  };
  canAutoWrite: boolean;
}
```

---

## 四、双轨迁移保护策略

### A. 尚未执行 V19 的数据库
- 在 `migrations.js` 中直接使用已修复的 `reconstructSubscriptionSnapshot` 与 `inspectSubscriptionSnapshot`。
- Migration 18 与 19 在首次执行时即按照正确规则运行，不再产生错误覆盖。

### B. 已经执行过 V19 的数据库
- 新增 **Migration 20** (`billing-v2-snapshot-provenance-repair`)。
- 对全量订阅重新执行 `inspectSubscriptionSnapshot`：
  - 若解析出有效正确的快照且当前快照存在错误（如 J1 的 100 分误写，或 J2 的 1500 分误写），自动原子修正为真实履约值（400 分）。
  - 若属于 J3 无来源订阅且此前被误填了虚假快照，清空快照（`snapshot_json = ''`），使其正确进入核查队列。
