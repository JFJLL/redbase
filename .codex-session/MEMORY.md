# 会话记忆

## 范围
- 项目：RedBase Vue 迁移闭环与 P1 功能补齐
- 目录：`D:\download\pic-vec\redbase-fullstack-latest`
- 分支：`codex/vue-migration-closure-20260805`
- 基线/当前 HEAD：`a9fad7cc9ee8`
- 最后更新：2026-08-06（当前工作区快照；另一个执行会话仍可能继续修改）

## 当前目标
完成 Vue 迁移闭环，确保付费生图任务恢复、严格深链、统一继续改图、优秀内容素材认领/上传、产品图安全删除等功能可正式发布；完成最终独立审查和 R3 验证后，再提交、推送、合并到 `master`，最后部署生产服务器。

## 当前状态
- 当前工作区有 34 项未提交变更：20 个已跟踪文件修改/删除，14 个未跟踪新增文件；不要清理、覆盖或重置。
- 主要迁移闭环已实现：生图任务跨刷新/切页/重登恢复，失败只退款一次，组图恢复，严格深链零错误 POST，统一图片继续改图，优秀内容素材能力，产品图删除保护，旧 `/generation` 兼容重定向。
- P1 四项功能已经进入当前工作区：
  1. 历史普通图、组图任一页、改图历史继续修改，保留 `generationId/parentEditId/slideIndex` 链路。
  2. 朋友圈图、公众号长图、风格化图生成结果可继续修改。
  3. 优秀内容仿图文可在流程内上传产品图、查看并认领未归属素材。
  4. 产品图删除前确认，并清理所有选题中的失效引用。
- 独立审查曾发现两个 major，当前代码已修：
  - 仿图文上传/认领后未同步 `assetMode`，界面显示已选但生成请求不带产品图。
  - 历史稀疏组图把展示序号误当源 `slideIndex`，可能改错页；默认“查看→改图”也漏传索引。
- 相关补强：异步认领期间切换品牌不会把旧品牌素材污染到新品牌。
- 修复后的定向测试、前端全量、类型、构建、预算、后端 unit/integration/data/AI eval 已通过；`git diff --check` 曾通过。
- 一次单独执行 `npm run smoke:api` 因当时 3013 端口无服务而失败，属于环境前置条件，但仍必须在隔离服务下重新成功执行。
- 修复后的独立 reviewer 尚无最终结论：最后一位 reviewer 被用户要求停止，不能作为审查证据。
- 当前 `.verification/receipt.json` 显示 pass/fingerprint `6d309a...`，但它早于最新 P1 修复，必须视为过期；最新一次 PlanOnly 曾得到当前 diff 指纹 `335eff10...`，仍应由最终验证重新计算。

## 关键决策
- 所有恢复扫描只读取/轮询已有任务，不自动创建新任务，避免重复扣费。
- 继续改图统一复用共享 `ImageEditPanel`/`useImageEdit`，避免各页面链路漂移。
- 历史组图始终使用源页 `slideIndex`，不能使用过滤后的显示位置。
- 仿图文素材选择必须同时更新素材 ID 和素材使用模式；品牌切换需防旧异步响应回灌。
- 当前进程内幂等锁只承诺 PM2 单实例；多实例部署需要数据库级唯一约束，不能宣称已解决。

## 约束
- 所有 shell 命令必须通过 `rtk`；先读 `AGENTS.md`、`verification-policy.json`，有 `.codegraph/` 时先用 `rtk codegraph explore`。
- 保留当前 34 项改动，不得 `git reset --hard`、`git checkout --`、删除用户文件或用测试降级换取通过。
- 不调用真实 AI、RunningHub、短信、支付宝；使用隔离 DB、fake provider 和出站 fail-fast。
- 密钥只来自环境变量或被忽略的 `config.local.json`，不得输出或提交。
- 在最终验证完成前不要提交、推送、合并、部署。
- 生产部署必须保持 `/home/red/work/moneyboost/redbase` 在 `master`，并确认 PM2 `fork`、`instances: 1`。

## 关键文件
- `frontend/src/features/generation/components/ImageEditPanel.vue`：共享继续改图 UI。
- `frontend/src/features/generation/composables/useImageEdit.ts`：共享改图状态与链路。
- `frontend/src/features/generation/composables/useImageJobRecovery.ts`：全局任务恢复。
- `frontend/src/features/history/views/HistoryView.vue`：历史普通图/组图/稀疏页继续改图。
- `frontend/src/features/excellent/views/ExcellentView.vue`：仿图文上传、认领、品牌切换保护。
- `frontend/src/features/generation/components/ProductImagePanel.vue`：删除确认与引用清理。
- `src/server/api/image-generation-routes.js`：恢复 API、签名与幂等流程。
- `tests/api/image-job-recovery.test.js`：恢复/退款/并发契约。
- `frontend/src/features/excellent/__tests__/assetPicker.test.ts`：认领/上传后生成请求素材契约。
- `frontend/src/features/generation/__tests__/imageEditFlow.test.ts`：历史稀疏组图和改图链路。
- `outputs/p1-final-closure-handoff-2026-08-06.md`：上一份详细交接（ignored）。

## 验证
- 已通过：前端 295/295、`typecheck:frontend`、`build`、`budget`、后端 unit 613/613、integration、data、AI eval；这些是修复后的阶段性结果。
- 已浏览器验证：隔离 DB 下历史稀疏组图显示“第 2 张/第 4 张”，选择第 4 张继续改图时请求携带 `generationId=8801`、`slideIndex=3`；未调用真实 AI。
- 尚缺：隔离服务下 `smoke:api` 成功；仿图文上传/认领→生成请求的完整 Kimi 浏览器验收；修复后全新独立 reviewer；最终完整 R3 verifier；新 receipt 指纹匹配最终 diff。
- RunningHub 初跑误触的一次真实调用，其费用、任务和数据保留状态只能由用户登录供应商后台人工核对。

## 待办
1. 等当前执行会话结束，先读取其最终报告，再现场执行 `rtk git status --short`；以文件和命令结果为准更新本记忆。
2. 若执行会话没有补齐，启动隔离服务并让 `npm run smoke:api` 成功，保存真实输出。
3. 用 Kimi WebBridge 验收仿图文：品牌内上传/认领素材→生成请求确实携带所选 `productImages`；禁止真实服务出站。
4. 冻结覆盖全部 tracked/untracked 文件的最终 diff；启动全新、只读、未参与实现的 reviewer；保存 agent id、原始结论、diff SHA256 和审查前后工作区状态。审查后若改源码，必须换新 reviewer 重审。
5. 运行完整 R3：`PlanOnly`、全量 `verify-change.ps1`、`-CheckReceipt`，确保 receipt `status=pass` 且 fingerprint 匹配最终 diff。
6. 人工确认 RunningHub 后台以及生产 PM2 为 `fork/instances=1`。
7. 只有以上全部满足后再提交/推送功能分支；建议创建 PR 合并到 `master`，不要直接在生产服务器上开发或推送。
8. 合并后服务器按干净工作区流程部署：`git switch master` → `git pull --ff-only origin master` → 安装锁定依赖/构建（如本次需要）→ `pm2 restart redbase` → 健康检查和关键页面验收。

## GitHub 发布顺序
1. 本地最终核对：`rtk git status --short`、`rtk git diff --check`、receipt current。
2. 暂存前逐项审阅，避免提交 `config.local.json`、数据库、日志、`.verification/`、`artifacts/verification/`、`outputs/` 中的本地证据或密钥。
3. `rtk git add <明确的源码/测试/文档文件>`。
4. `rtk git diff --cached --stat` 与 `rtk git diff --cached --check`。
5. `rtk git commit -m "feat: complete Vue migration recovery and image editing"`。
6. `rtk git push -u origin codex/vue-migration-closure-20260805`。
7. 在 GitHub 创建 PR：`codex/vue-migration-closure-20260805` → `master`，等待/复核检查后合并；若仓库没有 PR 流程，才在明确授权后本地 fast-forward/merge 并推送 `master`。
8. 合并完成后，生产服务器只拉取 `master`，禁止部署功能分支。

## 注意事项
- “另一个执行会话还在跑”意味着本文件只是 2026-08-06 当前快照；它结束后的最终 diff、测试和 reviewer 结果可能变化。
- 不要把旧 receipt、被中断 reviewer 或阶段性测试当作最终发布证明。
- 不要因为用户说“推送”就跳过最终 R3、独立审查、单实例确认和敏感文件检查。
