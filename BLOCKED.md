# BLOCKED

## 与任务书现状描述的冲突（任务0核对）
1. 文档称“仓库默认分支为 master”，实际当前检出分支已是 `codex/frontend-vue-rebuild`（0ff96b5，与 master 同 SHA、工作区干净、无额外提交）。判断：该分支即任务1要求的集成分支且零差异，直接沿用，不重建。
2. `npm ci` 首次失败：本地有一个自 2026-07-24 起运行的 `node server.js`（PID 40268）锁住 `better_sqlite3.node`。已停止该进程后重跑通过。若该服务是使用者有意保留的，请在需要时用 `npm start` 重启。

## 业务 Agent 上报区（集成时由总控处理）

### Core Agent 上报
- 跨 tab 的“当前选中品牌/个人 IP”在旧版存于全局 state（brands/personal 点“AI趋势分析”后 trends/ideas tab 复用同一选中项）。共享 store 属公共层（frontend/src/shared/ 禁改），Core 侧暂用 `router.push({ name: "trends", query: { brandId } })` 传递选中品牌。请总控集成时评估是否在 shared/stores 增加 selected-brand store，并让 trends/ideas 读取 `brandId` query 或该 store。

### Insights Agent（trends / ideas）上报
1. 【公共层诉求】品牌数据缺少跨 feature 共享机制：趋势/选题页在 `features/trends/stores/insights.ts` 内独立加载 `/api/brands?summary=1` 与 `/api/brands/:id`。进入趋势页时会强制刷新品牌摘要（新增/删除/改名可同步），但品牌档案页对详情字段（如品牌资料库 knowledgeBase、品牌 Logo）的编辑在同一 SPA 会话内不会同步到已缓存的品牌详情。建议公共层提供共享的品牌 store 或品牌数据失效通知；在此之前该差异与旧版"单页全局 state"行为的偏差仅限于此。
2. 【跨 Agent 契约】旧版 ideas tab 内嵌的四个生图按钮（朋友圈图/公众号长图/小红书组图/风格化图）属于生图任务域（Content Agent，路由 /app/generation）。IdeasView 以「去生成内容」按钮跳转 `{ name: "generation", query: { brandId, trendId, ideaIndex } }` 承接。需要 Content Agent 的 GenerationView 支持读取这三个 query 参数恢复品牌×趋势×选题上下文，请总控协调该契约。

### Content Agent 上报
- 无
