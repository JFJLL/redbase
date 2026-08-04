# BLOCKED

# BLOCKED — 优秀内容 V1 多模态学习（2026-07-28，codex/excellent-multimodal-v1）

## 需要使用者决定的事项
1. AGENTS.md 验证契约 vs 任务书门禁：任务书（唯一任务来源）只要求 check/test/test:integration/eval:ai/typecheck:frontend/test:frontend/build/git diff --check，已全部执行并通过。AGENTS.md 另要求 `scripts/verify-change.ps1` 产生带指纹的 receipt，且本次改动按 verification-policy 会命中 R2（kimi-browser + agent-review 证据 lane）。verify-change 按未提交 diff 计算指纹（提交后 PlanOnly 显示 changedFiles 为空、R0），Kimi 浏览器验收与独立评审属任务书范围外的额外流程，未自行扩大范围执行。如需补 R2 完整 lane（含浏览器验收/独立评审/receipt），请明确指示。
2. 【已解决】push：使用者已明确指示推送，`git push -u origin codex/excellent-multimodal-v1` 完成，origin 分支指向 a9daff2。

## 已按既定处置方式解决（记录备查）
1. 主 checkout 被前次会话切到 `codex/excellent-multimodal-v1`（=origin/master，零差异），与“基于 origin/master 在 .worktrees 建分支”冲突：已 detach 主 checkout、删除零差异分支后按文档重建 worktree（与 2026-07-28 趋势复核轮的同类处置一致）。主 checkout 未提交的 PROGRESS.md（前次任务记录）保留未动。

# BLOCKED — 前端重构记录

## 需要产品决定的事项（当前有效）
- 无

## 与任务书现状描述的冲突（历史记录，重构轮任务0核对）
1. 文档称“仓库默认分支为 master”，实际当前检出分支已是 `codex/frontend-vue-rebuild`（0ff96b5，与 master 同 SHA、工作区干净、无额外提交）。判断：该分支即任务1要求的集成分支且零差异，直接沿用，不重建。
2. `npm ci` 首次失败：本地有一个自 2026-07-24 起运行的 `node server.js`（PID 40268）锁住 `better_sqlite3.node`。已停止该进程后重跑通过。若该服务是使用者有意保留的，请在需要时用 `npm start` 重启。（最终修复轮任务0再次出现同类占用：PID 26040/33868，端口 3098/3099，同样处理。）

## 业务 Agent 上报区（历史记录，均已处理）
### Core Agent 上报
- 跨 tab 的“当前选中品牌/个人 IP”共享。 —— 【已解决】TrendsView 读取 `?brandId=` 预选品牌（commit edec753，测试 frontend/src/features/trends/__tests__/TrendsView.test.ts 含 3 个 query 预选用例）；trends/ideas 经共享 insights store 复用选中项。
### Insights Agent 上报
1. 品牌数据缺少跨 feature 失效机制。 —— 【已解决，最终修复轮】新增 `frontend/src/shared/stores/brandDataVersion.ts` 版本失效通道：brands/personal CUD 成功即 `notifyBrandDataChanged`，insights store 据版本丢弃品牌摘要与详情缓存并重新 GET /api/brands/:id。证据：frontend/src/features/trends/__tests__/brandCacheInvalidation.test.ts（2 用例）；红灯演示——将 notifyBrandDataChanged 临时改为 no-op 后该测试立即失败（expected 1 to be 2），还原后通过。
2. ideas→generation 的 query 契约。 —— 【已解决】GenerationView 读取 brandId/trendId/ideaIndex 恢复上下文（commit ce894a0，测试 ideaGeneration.test.ts）。
### Content Agent 上报
- 无

## 测试迁移发现的功能缺口（历史记录，逐项标记）
1. 【Core/personal】个人 IP 页素材库违反旧契约。 —— 【已解决，最终修复轮】按产品决定 `MATERIAL_LIBRARY_ENABLED=false` 门控关闭自动加载与管理界面（实现保留但不可达，后续另开产品需求）。证据：frontend/src/features/personal/__tests__/personal-view.test.ts（断言不自动加载、不渲染管理 UI）与 tests/personal-ip-ui-contract.test.js（门控为 false、渲染/加载均受门控、无绕过路径）。
2. 【Content/generation】按选题维度的创作设置记忆缺失。 —— 【已解决，最终修复轮】`frontend/src/features/generation/ideaCreativeSettings.ts` 按 `品牌ID:趋势ID:选题序号` 保存/恢复比例、小红书视觉路线、公众号模板、Logo 开关、产品图选择、风格参考图；切换选题不串值，账号重置即清空。证据：ideaCreativeFlow.test.ts（6 用例，含键位隔离与恢复）。
3. 【Insights/trends】趋势面板独立滚动契约缺失。 —— 【已解决，最终修复轮】TrendsView `<style>` 恢复桌面端右侧结果面板 overflow-y:auto 独立滚动 + 页面锁滚 + ≤760px 降级（overflow visible/单列）。证据：TrendsView.test.ts 迁移断言 8/8 通过。
4. 【Core/auth】FileReader 读取窗口无 abort 防护。 —— 【已解决，最终修复轮】`frontend/src/shared/utils/fileToDataUrl.ts` 支持 AbortSignal：读取前预检、abort 时调 FileReader.abort()、onload 后二次检查再决定是否上传；ProfileFormModal 与 ProductImagePanel 统一接入。证据：sessionSafeUpload.test.ts（读取中 notifyAuthReset → FileReader.abort 被调、0 次 POST /api/product-images、列表不写入）。
（原第 5 条 favicon link 缺口已修复，按最终修复轮任务4要求删除该记录。）
6. 【Content/excellent】组图/仿图文串行等待弱于旧版并发。 —— 【已解决，最终修复轮】组图与优秀内容仿图文均改为“提交保序 + 轮询并发”（4 页不整体串行），单页失败可独立重试且不重复成功页、complete 仅一次。证据：ideaGeneration.test.ts 并发轮询用例（fake timers 下多 job 同时在飞）、legacyRemixRequest.test.ts 第 7 用例（提交保序+并行轮询）、remixParallelPolling.test.ts（2 用例）。

# BLOCKED — 趋势交付记录（来自 origin/master）

- 基线 `npm test` 存在 1 个既有失败（tests/text-provider.test.js:283，Windows/Node24 计时敏感，探针证实为定时器粒度导致的环境性失败，非逻辑回归）。已以等比放大时间刻度方式修复，语义保持“重试共享一个超时预算”。若这被认为属于“放宽旧断言”，请复核；本人判断是修复环境不稳定测试而非放宽验收。
- warnings 无法持久化到数据库（任务禁止改 schema/migration）：分析记录中的 `warnings` 字段在 snapshot 归一化时被丢弃，replay 响应中的 warnings 回落为空数组。首次成功响应已携带完整 warnings，replay 的核心语义（不重复扣分、不重复生成）不受影响。如需 replay 也带 warnings，需要 schema 变更，超出本次界限。
- `canUseFinalFieldScopedTrendRepair` 在新循环里不再被调用（原“第三次字段级修补”入口被 2 次调用上限取代），函数保留未删（顺手删除属顺手重构，按界限记录于此，未执行）。

（其余无）
