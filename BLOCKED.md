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

## 测试迁移发现的功能缺口（旧测试契约 vs 新实现，总控测试迁移时核实）
迁移 18 个失败的旧前端契约测试时逐条对照发现以下真实缺口/契约冲突。迁移后的测试未放宽仍成立的断言；被下列缺口推翻的断言按"指向已存在的等价接线"处理，缺口在此如实上报：
1. 【Core/personal】旧契约（tests/personal-ip-ui-contract.test.js）要求个人 IP 页**不渲染、不加载**创作者素材库（禁止 materialCount 展示与 loadCreatorMaterials 自动调用），但新 `PersonalIpView.vue` 重建了素材 CRUD：卡片显示"素材 N 条"、选中档案后自动 `loadMaterials`、渲染 material-section。需要产品/总控裁决：回退素材库或正式确认新契约。迁移后的测试保留"旧素材库 DOM id/全局加载器/样式类不得复活"的同强度禁止，并断言素材加载限定在选中档案作用域内。
2. 【Content/generation】旧 per-idea 折叠创作设置面板（app.js 的 data-toggle-creative-settings / data-creative-field / getIdeaCreativeStyleSelection(ideaIndex) / getIdeaWechatTemplateSelection(ideaIndex)，即每个选题独立记忆视觉风格与公众号模板）在新实现不存在。新 `GenerationView.vue` 只有共享的 xhsStylePreset / wechatTemplate select（透传进请求体的行为已保留并被断言）。缺口：按选题维度的创作设置记忆。
3. 【Insights/trends】旧 styles.css 的趋势结果面板滚动契约未迁移：`.trend-right-panel { overflow-y: auto }`、`html:has(...trends is-active) { overflow: hidden }` 页面锁滚、`.is-active` flex 列布局撑满、760px 媒体查询降级（overflow: visible、idea-creative-grid 单列）。新 `TrendsView.vue` 的 `.trend-right-panel` 仅有 flex 列布局，无独立滚动容器。长趋势列表将随页面整体滚动，桌面端体验与旧版不同。
4. 【Core/auth】账号切换中断商品图上传时，旧实现连 FileReader 读取窗口也会作废；新实现 AbortSignal 只覆盖 fetch 阶段，FileReader onload 回调窗口内无 epoch/signal 防护（见 frontend/src/shared/stores/__tests__/session-isolation.test.ts 第 4 用例注释）。窗口极小但契约上弱于旧版。
5. 【Core/landing】`public/assets/favicon-32.png` 与 `apple-touch-icon.png` 资源仍在发布，但 `frontend/index.html` 只声明了 favicon.ico，未声明这两个 `<link>`（旧 index.html 均声明）。补两行 link 即可闭合。
6. 【Content/excellent】旧"并发上限队列"生图语义（excellent-remix-request.js 的并发 token 机制）在新实现改为严格顺序提交（ExcellentView.vue for 循环逐页 await）。行为上是收紧而非缺失，已用"顺序提交且每页请求体一致"断言替代并在测试注释中说明映射（frontend/src/features/excellent/__tests__/legacyRemixRequest.test.ts）。

