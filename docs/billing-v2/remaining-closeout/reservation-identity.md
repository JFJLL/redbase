# 完整任务身份、物理主键与终态重试规则 (Reservation Identity)

## 1. 任务身份定义与规范格式

为从根本上隔离不同业务上下文与多用户竞争，任务在积分账本中全程使用单一规范身份（Canonical Task Key）：

1. **趋势分析 (trend_analysis)**:
   `trend_analysis:${userId}:${brandId}:${bucketKey}:${requestId}`
   - 强制绑定 `userId`, `brandId`, `bucketKey`, `requestId` 四元组。
   - 任何同一用户在不同品牌或不同热点分类下共用 `requestId` 的场景，由于 `brandId` 或 `bucketKey` 不同，生成互不干扰的独立任务键。

2. **优秀内容方案 (excellent_${kind})**:
   `excellent_${kind}:${userId}:${cleanRequestId}` 或带有重试执行令牌的 `excellent_${kind}:${userId}:${cleanRequestId}:${attemptToken}`
   - 严格绑定所属用户与方案类别（`direction` / `fusion`）。
   - 针对超时替换或重试场景，附带执行令牌（如 `created_at` 毫秒级时间戳），实现旧尝试与新尝试物理隔离。

3. **服务端计算与防篡改**:
   - `buildCanonicalTaskKey` 必须由服务端根据已认证上下文计算。
   - 若显式传入 `taskKey`，必须校验其与业务上下文计算出的期望键一致；不一致时直接拒绝（抛出 `TASK_KEY_MISMATCH`），禁止外部伪造任务键。

---

## 2. 数据库物理主键与约束重建 (V17 Migration)

在 V15 迁移中，`task_credit_reservations` 将主键错设为 `PRIMARY KEY(task_id, lot_id)`。
在 SQLite 中，`ALTER TABLE ADD COLUMN` 无法移除旧主键约束。

增量迁移 V17 对 `task_credit_reservations` 实施了完整的表重建（Table Reconstruction）：

```sql
CREATE TABLE task_credit_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  task_type TEXT NOT NULL,
  lot_id INTEGER NOT NULL,
  reserved_credits INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (lot_id) REFERENCES credit_lots(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uq_task_res_key_lot ON task_credit_reservations(task_key, lot_id);
CREATE INDEX idx_task_res_key_status ON task_credit_reservations(task_key, status);
CREATE INDEX idx_task_res_user_status ON task_credit_reservations(user_id, status);
CREATE INDEX idx_task_res_task ON task_credit_reservations(task_id);
```

- **物理唯一性**：`id INTEGER PRIMARY KEY AUTOINCREMENT` 作为内部物理预占标识。
- **业务唯一性**：`UNIQUE(task_key, lot_id)` 确保同一任务在同一批次中仅有一条预占记录。
- **多品牌多任务兼容**：Brand A 与 Brand B 即使共用 `task_id` 并从同一 `lot_id` 扣款，由于 `task_key` 完全不同，物理插入互不冲突。

---

## 3. 终态不可重用与重试规则

1. **单向状态机**:
   `reserved` 只能流转至 `settled`（成功扣除）或 `released`（失败释放）。
   一旦进入 `settled` 或 `released`，该任务键永久处于终态。

2. **禁止删除重占**:
   移除了原代码中 `DELETE FROM task_credit_reservations WHERE task_key = ? AND status = 'released'` 的危险逻辑。
   若原任务键处于 `settled` 或 `released`，再次尝试预占直接抛出 `RESERVATION_TERMINAL`。

3. **迟到回调防御**:
   - 结算与释放必须且仅按 `task_key = ? AND status = 'reserved'` 进行原子查询和更新。
   - 若任务已成功（`settled`），迟到的失败回调在匹配 `status = 'reserved'` 时影响行数为 0，不产生任何副作用，绝不误退款或误释放。
   - 若任务已释放（`released`），迟到的成功回调无法结算，明确拒绝。

4. **消除 fresh spend 旁路**:
   新任务若未在 `task_credit_reservations` 中建立有效预占，`settleCreditsForTask` 抛出 `RESERVATION_NOT_FOUND`；移除了自动扣减当前用户可用余额的未预占直接补扣（fresh spend）逻辑。对于历史在途请求，仅在 `trend_analysis_requests` 严格验证历史预占事实后才走受控兼容路径。
