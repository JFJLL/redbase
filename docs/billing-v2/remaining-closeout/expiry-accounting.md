# 积分到期账务、守恒定律与并发防重规范 (Expiry Accounting)

## 1. 资金守恒不变式 (Conservation Invariant)

针对任意周期积分批次 `credit_lots`，在其全生命周期中必须满足以下守恒公式：

$$\text{initial\_credits} = \text{used\_credits} + \text{expired\_credits} + \text{remaining\_credits}$$

对于当前时刻仍处于生效中的批次：
$$\text{remaining\_credits} = \text{usable\_credits} + \text{reserved\_credits}$$

当到期时刻（`expires_at <= nowIso`）到达时：
1. **未预占部分（Unreserved）**：立即失效，生成 `cycle_expire` 经济事件，额度计入已失效总额。
2. **已预占部分（Reserved）**：
   - 若后续任务**成功**：由原批次正常划扣，计入 `used_credits`；
   - 若后续任务**失败**：任务释放额度在释放事务中由于已过期直接失效，生成 `cycle_expire` 经济事件，计入已失效总额。
3. **算例守恒验证**：
   - 批次初始 50 分；
   - 任务 A 预占 20，任务 B 预占 10；
   - 未预占 20 分到期失效（产生 -20 到期流水）；
   - 随后任务 A 失败，释放的 20 分立即失效（产生 -20 到期流水）；
   - 任务 B 成功，消费 10 分（产生 -10 消费流水）；
   - 最终统计：到期 40 + 消费 10 = 50，`reserved_credits = 0`，`remaining_credits = 0`，完美守恒。

---

## 2. 旧到期记录规范化 (G3)

历史数据库中存在部分合法批次：
- `credit_lots.status = 'expired'`
- `credit_lots.remaining_credits = 20`
- `credit_events` 中已正确记录过 `-20` 的 `cycle_expire` 流水。

原新版逻辑将 `remaining_credits > 0` 统一视作未扣除，重复记账导致到期总额变为 40。

**本次治理方案**：
1. **事实关联复核**：在处理批次到期时，通过 `lotId` 关联比对 `credit_events` 中已记账的失效总和 `alreadyRecordedExpired`。
2. **最大应失效额度**：
   $$\text{maxExpirable} = \max(0, \text{initial\_credits} - \text{used\_credits} - \text{reserved\_credits})$$
3. **真实应补记失效额度**：
   $$\text{toExpire} = \max(0, \text{maxExpirable} - \text{alreadyRecordedExpired})$$
4. **两类处置分支**：
   - **已记账、字段未归零（$\text{toExpire} = 0$）**：
     仅对批次字段做规范化：`UPDATE credit_lots SET remaining_credits = reserved_credits, status = 'expired'`，**不插入任何新的到期流水**。
   - **确实漏记账（$\text{toExpire} > 0$）**：
     原子插入一笔 $\text{credit\_delta} = -\text{toExpire}$ 的 `cycle_expire` 流水，并更新批次字段。

---

## 3. 跨进程并发防重与条件更新 (G4)

针对多实例、多 worker 部署环境下同时触发 `rescanExpiredLots` 的竞态防御：

1. **事务外仅发现候选**：
   外层查询仅以 `id` 作为候选拉取，不把外层读到的数量作为经济事实。
2. **事务内二次复核**：
   进入写事务后，重新读取当前最新 `remaining_credits`, `reserved_credits`, `status` 以及最新的 `credit_events` 失效历史。
3. **条件更新（CAS）认领**：
   ```sql
   UPDATE credit_lots
   SET remaining_credits = ?, status = 'expired', updated_at = ?
   WHERE id = ? AND remaining_credits = ? AND reserved_credits = ?
   ```
   只有当前批次实际未被修改时，该更新才能影响 1 行。若影响行数为 0，说明另一并发进程已认领处理，当前进程立即退出，避免重复执行。
4. **稳定业务幂等键**：
   - 未预占失效事件：`idempotencyKey: lot_expire:${lot.id}:unreserved`
   - 任务释放失效事件：`idempotencyKey: lot_expire:task_release:${lot.id}:${taskKey}`
   同事务内校验幂等键存在性，确保即使同一阶段被重试执行，同经济效果事件绝对只入账一次。
