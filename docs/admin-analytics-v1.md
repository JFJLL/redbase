# RedBase 管理后台数据分析 V1 架构与指标口径文档

本文档详细定义 RedBase 管理后台数据分析 V1 的系统架构、事件字典、数据生命周期、指标口径与对账排查方案。

---

## 1. 架构说明

RedBase 管理后台采用 **业务事务分离、事件事实驱动、独立聚合计算** 的架构：

- **业务数据层 (OLTP)**：包含 `users`、`brands`、`generations`、`image_jobs`、`video_projects`、`video_clips`、`payment_orders`、`credit_events`。保持强一致性与业务生命周期。
- **分析事实层 (Analytics Facts)**：包含 `analytics_events` 和 `ai_task_attempts`，属于 append-only 的事实流。不设外键约束，当用户或业务记录物理删除时，匿名事实与聚合数据完整保留。
- **可观测分析层 (AI Observability)**：每一个文本、图片、视频模型物理调用、重试与拼接均记录为独立的 `ai_task_attempts`，区分 `initial`、`auto_retry`、`manual_retry`、`result_retry`、`assembly_initial`、`assembly_retry` 与 `historical_summary`。
- **多维聚合计算层 (SQL Metrics)**：由后端 SQL 进行时区自然日分组（Asia/Shanghai）、区间统计与缓存（15~30s 短 TTL 缓存），避免前端拉取全量明细后在客户端计算。
- **前端后台壳层 (Vue SPA)**：单页应用路由维持 `/admin/`，通过 URL hash (`#overview`、`#users`、`#features`、`#ai`、`#finance`、`#system`、`#management`) 实现模块懒加载与浏览器导航历史同步。

---

## 2. 业务数据与分析事实的区别

| 维度 | 业务数据 (Business State) | 分析事实 (Analytics Facts) |
| :--- | :--- | :--- |
| **表名** | `generations`, `video_projects`, `users`, etc. | `analytics_events`, `ai_task_attempts` |
| **生命周期** | 可被用户或管理员主动硬删除；媒体可定时清理 | 永久 append-only，只增不减 |
| **外键关联** | 关联 `users.id`, `brands.id`, etc. | **无外键**；记录稳定 `actor_key` (`user:<id>`) |
| **敏感数据** | 管理员可见脱敏手机号与内容 | **禁止保存** 手机号、昵称、Prompt、签名URL、Token |
| **用户删除影响** | 物理级联删除业务行与媒体 | `actor_user_id` 置为 `NULL`，保留 `actor_key` 与统计事实 |

---

## 3. 媒体资源生命周期与 30 天清理机制

### 3.1 核心语义区分

- **定时资源清理 (Purge)**：
  - 针对创建超过 30 天且 `visibility_status = 'active'` 的生成记录。
  - **仅删除物理媒体文件**（主图、小红书组图各页、编辑历史、视频输入素材冻结副本、Clip 视频、Poster 封面、连续帧、最终合成片）。
  - **保留全部数据库记录**（`generations`、`image_jobs`、`video_projects`、`video_clips`、`credit_events`、`payment_orders` 等元数据与脚本）。
  - 标记 `generations.visibility_status = 'expired'`，`asset_status = 'purged'`，记录 `asset_count`、`asset_bytes`、`assets_deleted_at`。
  - 清除 payload 中的失效 URL 和存储路径，保留 `purged: true` 标记。
  - 用户端历史列表（`/api/history`）默认仅返回 `visibility_status = 'active'` 的记录；管理后台仍可检索全量历史及其元数据。
  - 清理前后，系统历史收入、积分流水、有效创作数、产出数与成功率等指标**完全不受影响**。

- **主动删除 (Hard Delete)**：
  - 用户或管理员主动触发删除。
  - 物理删除关联媒体文件（如已被定时清理则安全 no-op）。
  - 物理删除 `generations`、`image_jobs`、`video_projects`、`video_clips`。
  - `credit_events` 解除关联并打上删除审计标记。
  - `analytics_events` 和 `ai_task_attempts` 予以保留，经营大盘指标不倒退。

---

## 4. 事件字典 (analytics_events)

所有事件拥有唯一且幂等的 `event_key`，支持服务重启与重复回填：

| 事件名称 | 触发时机 | 关键属性 |
| :--- | :--- | :--- |
| `user_registered` | 用户注册成功或回填 | `actor_key`, `occurred_at`, `account_type` |
| `user_active_day` | 用户每日首次鉴权 API 请求 (Asia/Shanghai) | `event_key: user_active_day:<YYYY-MM-DD>:<userId>` |
| `brand_created` | 品牌档案创建成功 | `actor_key`, `entity_id: brandId` |
| `trend_analysis_started` | 趋势分析开始 | `feature: trend_analysis`, `entity_id: requestId` |
| `trend_analysis_completed` | 趋势分析成功交付 | `duration_ms` |
| `trend_analysis_failed` | 趋势分析失败 | `status: failed` |
| `excellent_direction_completed` | 优秀内容方向分析完成 | `feature: excellent_direction`, `credit_cost` |
| `excellent_direction_failed` | 优秀内容方向分析失败 | `status: failed` |
| `excellent_fusion_completed` | 优秀内容融合生成完成 | `feature: excellent_fusion`, `credit_cost` |
| `excellent_fusion_failed` | 优秀内容融合生成失败 | `status: failed` |
| `output_completed` | 图片/组图/长图生成成功 | `feature`, `entity_id: generationId`, `credit_cost` |
| `output_failed` | 图片生成失败 | `feature`, `status: failed` |
| `video_script_started` | 视频脚本生成开始 | `feature: video_script`, `entity_id: requestId` |
| `video_script_completed` | 视频脚本生成完成 | `source_id: generationId`, `credit_cost` |
| `video_script_failed` | 视频脚本生成失败 | `status: failed` |
| `video_project_created` | 视频项目创建与扣费 | `model`, `mode`, `resolution`, `aspect_ratio`, `media_duration_sec` |
| `video_project_completed` | 视频最终成片拼接完成 | `credit_cost: netCredits`, `duration_ms` |
| `video_project_failed` | 视频项目最终失败 | `status: failed` |
| `payment_order_created` | 充值订单创建 | `amount_fen`, `provider`, `metadata.planId` |
| `payment_paid` | 充值订单支付成功 | `amount_fen`, `credit_delta`, `provider` |
| `payment_failed` | 充值订单超时失效或失败 | `amount_fen`, `provider` |
| `credit_consumed` | 积分实际扣除 | `credit_delta < 0`, `credit_cost` |
| `credit_refunded` | 任务失败自动退款 | `credit_delta > 0`, `metadata.refundForCreditEventId` |
| `credit_granted` | 管理员手动赠送额度 | `credit_delta > 0`, `metadata.adminUserId` |
| `asset_purge_completed` | 30 天物理媒体定时清理完成 | `quantity: count`, `asset_bytes: bytes` |
| `asset_purge_failed` | 媒体清理阶段异常 | `metadata.error` |
| `generation_deleted` | 内容主动物理删除 | `entity_id: generationId` |
| `user_deleted` | 用户注销或删除 | `entity_id: userId` (触发匿名化处理) |

### 客户端轻量事件 (白名单)
- `video_studio_opened` (打开视频工坊)
- `video_step_viewed` (浏览分镜步骤)
- `recharge_page_viewed` (进入充值页面)
- `final_asset_downloaded` (下载最终成品)

---

## 5. AI Task Attempts 规范

`ai_task_attempts` 记录所有底层物理模型调用与拼接过程：

- **Attempt 类型 (`attempt_kind`)**：
  - `initial`: 初始调用
  - `auto_retry`: 自动换 Key 或重试
  - `manual_retry`: 用户手动付费重试
  - `result_retry`: 结果下载/保存重新处理 (0 积分)
  - `assembly_initial`: 首次成片合成
  - `assembly_retry`: 重新拼接尝试 (0 积分)
  - `historical_summary`: 历史回填摘要 Attempt (`is_backfilled = 1`)
- **错误阶段 (`error_stage`)**：
  - `validation`、`billing`、`submission`、`provider`、`poll`、`download`、`persist`、`frame_extract`、`assembly`、`configuration`、`cancelled`、`unknown`
- **供应商成本 (`vendor_cost_fen`)**：
  - 在未接入真实供应商人民币计费账单前，固定保存为 `NULL`，前端显示“未配置”，绝不使用积分伪造。

---

## 6. 指标统计口径与公式

| 模块 | 指标名称 | 口径与公式 | 数据源与字段 |
| :--- | :--- | :--- | :--- |
| **总览** | 平均 DAU | 选定范围内每日去重 `actor_key` 均值 | `analytics_events(user_active_day)` |
| **总览** | 新增用户 | 选定时间内注册的用户数 | `analytics_events(user_registered)` |
| **总览** | 有效创作用户 | 至少成功生成 1 次内容的去重用户数 | `analytics_events(output_completed)` |
| **总览** | 付费用户 | 产生成功支付的去重用户数 | `analytics_events(payment_paid)` |
| **总览** | 累计营收 | 实收订单金额 (分 / 100) | `payment_orders(paid_at, status='paid')` |
| **总览** | Net 积分消耗 | Gross 扣除积分 - 退款积分 | `analytics_events(credit_consumed, credit_refunded)` |
| **总览** | AI 成功率 | 终止 Attempt 中 `status='completed'` / 总终止数 | `ai_task_attempts(status IN ('completed', 'failed'))` |
| **转化** | 产品主漏斗 | 注册 -> 品牌 -> 探索 -> 首次生成 -> 复购生成 -> 充值页 -> 下单 -> 支付成功 | 每一层按用户去重计算转化率 |
| **视频** | 视频完成率 | `completed` / (成熟终止 + 需要操作项目数) | 运行中任务不入分母；阻塞项目单列 |
| **视频** | 首次成功率 | 最终 `completed` 且无任何 retry attempt 的项目数 / 完成数 | `ai_task_attempts` 关联 `video_projects` |
| **视频** | 重试挽救率 | 曾进入失败或需操作状态，后续最终 `completed` 的项目比例 | `video_projects` 状态历史 |
| **财务** | ARPPU | 营业收入 / 付费用户数 | `payment_orders` |
| **财务** | 订单支付转化率 | 支付成功订单数 / 创建订单总数 | `payment_orders` |
| **系统** | 超时卡住任务 | 图片任务活跃 > 10min；视频任务活跃 > 2h | `image_jobs`, `video_projects` |

---

## 7. 时区与时间口径

- 系统全局统计以 **Asia/Shanghai (UTC+8)** 为准。
- 日期筛选参数 `from`、`to` 采用 **[from, to) 半开区间**。
- 日维度聚合使用 SQLite `strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours'))`。
- 对比周期取紧邻之前等长时间跨度 `[from - duration, from)`。

---

## 8. 数据回填与覆盖说明

- **可回填数据**：
  - 存量用户 (`users` -> `user_registered`)
  - 历史支付 (`payment_orders` -> `payment_order_created`, `payment_paid`, `payment_failed`)
  - 历史积分流水 (`credit_events` -> `credit_consumed`, `credit_refunded`, `credit_granted`)
  - 历史生成内容与视频项目 (`generations`, `video_projects` -> `output_completed`, `video_project_created`, `video_project_completed`)
  - 历史图片任务与视频片段 (`image_jobs`, `video_clips` -> `historical_summary` attempt)
- **不可回填数据**：
  - 已被旧版物理硬删除的记录无法恢复；
  - 埋点启用前的详细日活（DAU）和客户端步骤浏览数据（如进入充值页）；
  - 历史 Clip 的中间网络重试细节（仅生成 1 条 `historical_summary`，不伪造）。

---

## 9. 常见对账与故障排查方法

1. **财务对账**：
   - 运行 `npm run check` 验证数据库逻辑。
   - 对比 `SELECT SUM(amount_fen) FROM payment_orders WHERE status='paid'` 与 `SELECT SUM(amount_fen) FROM analytics_events WHERE event_name='payment_paid'`，两者应完全一致。
2. **积分对账**：
   - 用户当前总余额 `SELECT SUM(credits) FROM users` 与积分流水平衡：初始积分 + 充值与赠送 - 消耗 + 退款。
3. **卡住任务排查**：
   - 检查 `GET /api/admin/analytics/system` 中的 `stuckCount`。
   - 若图片任务卡住，检查 Provider 密钥与网络连接。
   - 若视频任务卡住，检查 Agnes Key 池是否有充足可用配额或处于 Cooldown 状态。
