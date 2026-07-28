# PROGRESS

本文件按任务线分节维护：前端重构（codex/frontend-vue-rebuild）与趋势“结果必达”交付（origin/master）。合并 master 时两边记录均完整保留，不覆盖。

# PROGRESS — 前端重构记录

## 最终修复轮（2026-07-28，基线 af820d50ab340dfef4211b9b06b603e7e46a2bbb）
### 任务0 取证（开发机 Node 24.11.1）
- git status 干净；HEAD=af820d50ab340dfef4211b9b06b603e7e46a2bbb（与文档基线一致）
- npm ci：首跑 EPERM（今晨启动的两个本地 `node server.js` PID 26040/33868 占用 better_sqlite3，端口 3098/3099；已停止，重启用 npm start）→ 重跑 exit 0；frontend ci exit 0
- check exit 0；npm test 388/388、integration 176/176、frontend 135/135，跳过/todo 全 0
- npm run build exit 0（原子替换 dist/public）；budget PASS：官网 15.4KB/100KB、工作台共享 39.5KB/250KB、10 路由懒加载、官网无 Vue chunk
### 修复轮状态
- [x] 任务0 取证
- [x] worktree：.worktrees/parity=codex/fe-final-parity、.worktrees/release=codex/fe-final-release
- [x] Parity：任务1 品牌/个人IP 变更后趋势选题缓存失效（shared/stores/brandDataVersion.ts）+ fileToDataUrl AbortSignal 账号隔离（shared/utils/fileToDataUrl.ts）——commit d5e6395
- [x] Parity：任务2 选题级创作设置（ideaCreativeSettings.ts，按 品牌:趋势:选题 键）+ 组图逐页提示词/单页生成/生成后改图(/api/image-edits)/单页重试不重复成功页/提交保序+轮询并发/complete 仅一次 + 风格化图真实参考图 + 仿图文并行轮询——commit d5e6395
- [x] Parity：任务4 趋势桌面独立滚动+760px 降级、个人 IP 素材库 MATERIAL_LIBRARY_ENABLED=false 门控隐藏——commit d5e6395
- [x] Release：任务3 build-frontend --stage-dir/--promote/--rollback、budget --dir、deploy-server.sh 九步含烟测失败自动回滚、static.js 仅 Vite 哈希文件 immutable（固定图片 no-cache）、README 对齐、新增 tests/build-frontend-modes.test.js——commit ae2986e
- [x] 集成合并（零代码冲突；唯一红灯为 tests/personal-ip-ui-contract.test.js 旧缺口断言与修复后契约冲突，总控同强度更新为门控契约，commit 55fd6bc）
- [x] 双 Node 验证 + 红绿灯证据（见下）
- [x] BLOCKED.md 逐项标记证据（favicon 项按要求删除记录）

### 修复轮验收证据（对话中已贴完整输出）
- 完成条件1（双 Node 全绿，跳过 0）：
  - Node 24.11.1：npm ci×2、check exit 0、root 400/400、integration 176/176、frontend 150/150、build exit 0、budget PASS（15.4KB/39.6KB）。
  - Node 20.20.0（D:\Tools\nvm\v20.20.0，worktree .worktrees/node20b）：npm ci×2 exit 0、68 个 check 文件 0 失败、root 400/400、integration 176/176、vue-tsc 0 错误、vitest 150/150、build exit 0、budget PASS。首跑 root 30 失败系 better_sqlite3 被 npm 子进程按 v24 ABI 编译（沙箱 PATH 干扰），`npm rebuild better-sqlite3`（v20 node 直跑）后全绿——环境问题非代码问题。
  - 测试总数 400+176+150=726 ≥ 任务0 基线 400+176+135=711，跳过/todo 全 0。
- 完成条件2（行为）：品牌编辑后趋势重取新资料（brandCacheInvalidation 2 用例）；读取图片中切账号 0 次上传（sessionSafeUpload 5 用例）；选题设置独立（ideaCreativeFlow 6 用例）；组图逐页提示词/改图/单页重试/并发轮询（ideaGeneration 并发用例 + legacyRemixRequest#7 + remixParallelPolling 2 用例）。红灯演示：notifyBrandDataChanged 临时 no-op → brandCacheInvalidation 2 用例失败（expected 1 to be 2）→ 还原后 2/2 通过。
- 完成条件3（发布安全）：候选目录预算红灯（删 manifest → --dir exit 1）前后 dist/public sha256 摘要一字不变（ed8be4f4…完全一致），还原绿灯摘要仍不变；promote 候选 B（marker）→ 模拟烟测失败 → --rollback → dist/public 摘要严格恢复为 A、marker 消失。build-frontend-modes.test.js 9 用例覆盖同类失败路径。
- 完成条件4（缓存与隔离）：运行时实测 /assets/qrcode.png、favicon.ico、redbase-logo.png → Cache-Control: no-cache；哈希文件 landing-BhREy-ry.js → public, max-age=31536000, immutable；官网 HTML 不含 base-/app- chunk（false）；budget 规则4 PASS。
- 完成条件5：BLOCKED.md 当前有效区为“无”，历史项逐条标记证据，favicon 项已删。
- 集成验收轮次：第 1 轮 1 个红灯（personal-ip 契约测试）→ 总控修正 → 第 2 轮全绿。共用 2/3 轮。
- 决策记录：personal-ip-ui-contract.test.js 的两条正断言由“素材区限定作用域”更新为“门控关闭 + 无绕过路径”——这是修复缺口后向旧线上契约的同强度回归，非放宽（旧断言描述的是缺口期临时状态）。
- 环境备注：node20b worktree 已用于验证，目录含 node_modules 沙箱无法删除，可手工清理（git worktree remove 注销后）。


## 十行纲要（任务0核对后）
1. 目标：原生前端迁移为 Vue3+Vite+TS 三入口（`/`、`/app/`、`/admin/`），官网不加载工作台代码，后端/DB/API 语义不变。
2. 并行边界：总控改根 package*、config.js、static.js、deploy/、scripts/、docs/、frontend 公共层；Core=landing/auth/brands/personal；Insights=trends/ideas；Content=excellent/generation/history/admin。
3. 业务 Agent 禁改 lockfile、Vite 配置、公共 router/store、Node 服务、部署文件；变更诉求写 BLOCKED.md。
4. 顺序：任务0基线 → 任务1公共骨架+基础commit+三worktree → 任务2三Agent并行 → 任务3按 Core→Insights→Content 合并 → 性能收口 → 部署流程 → 双Node验收。
5. 冲突让步序：数据正确与功能不变 > Node 20.20.0 可构建 > 加载速度 > 开发方便。
6. 最大风险：旧 app.js(265KB)业务逻辑密集，迁移遗漏字段/错误提示/权限行为；其次是 Node 20.20.0 无法本机复现，需以 engines 核验+服务器实测兜底。
7. 资源预算：官网初始 JS+CSS gzip ≤100KB；工作台公共初始 JS gzip ≤250KB；每业务路由独立 chunk；预算脚本机器可判。
8. 构建产物先进临时目录，Node 脚本原子替换 dist/public；构建失败不重启服务；本地未构建回退旧 public。
9. 测试红线：总数 ≥ 基线(单元433+集成176)，跳过=0；禁止 skip/删测试/放宽断言/调高预算。
10. 验收：双 Node 全绿 + 三入口烟测 + 预算通过 + 一次故意红灯与还原绿灯，最多3轮集成验收。

## 任务0 基线（2026-07-27，开发机 Node 24.11.1 / npm 11.13.0）
- git status --short：干净（无输出）
- 分支：codex/frontend-vue-rebuild @ 0ff96b5ae5ff6f025b1724918387fb8aaa9e5c02（与 master 同 SHA；差异说明见 BLOCKED.md 顶部）
- npm ci：通过（added 39 packages；此前需停掉自 7/24 运行的本地 `node server.js` PID 40268，它锁住 better_sqlite3.node）
- npm run check：通过（node --check 全部文件）
- npm test：tests 433 / pass 433 / fail 0 / skipped 0 / todo 0
- npm run test:integration：tests 176 / pass 176 / fail 0 / skipped 0 / todo 0
- 旧资源字节数：index.html 57952；app.js 271187；styles.css 107793；landing-v3.css 33606；admin.js 27117
- npm view vite engines → {"node": "^20.19.0 || >=22.12.0"}（含 Node 20.20.0 与 24.11.1）
- npm view @vitejs/plugin-vue engines → {"node": "^20.19.0 || >=22.12.0"}
- 备注：npm.ps1 在本会话 shell 有编码 bug，统一使用 npm.cmd 调用。

## 状态账本（每完成一项立即更新）
- [x] 任务0：基线采集与核对
- [x] 任务0：PROGRESS.md / BLOCKED.md 建立
- [x] 任务1：frontend/ 公共骨架（三入口 Vite+TS+Router+Pinia+Vitest；typecheck 通过、12 个前端测试全绿、构建通过）
- [x] 任务1：static.js 改造（dist/public 优先、/app//admin SPA 刷新、旧 public 回退；新增 5 个后端测试，npm test 438/438、跳过 0）
- [x] 任务1：scripts/build-frontend.cjs（临时目录构建+原子替换+失败不动线上目录）与 scripts/check-asset-budget.cjs（预算首跑 PASS：官网 1.2KB/100KB，工作台共享 37.9KB/250KB，10 业务路由全部懒加载）
- [x] 任务1：基础 commit + 三个 worktree（基础 commit 48e137b64795c57335d751ec26983777ffe799e9；worktree：.worktrees/core=codex/fe-core、.worktrees/insights=codex/fe-insights、.worktrees/content=codex/fe-content，均已装好 frontend 依赖）
- [x] 任务2：Core Agent 交付（commit 146c899 → 二轮无追加；landing/auth/brands/personal 迁移，含飞书登录、品牌 CRUD+产品图上传、个人 IP）
- [x] 任务2：Insights Agent 交付（commit eab2b11 + edec753 preselect brand；trends 轮询/证据链/机会点，ideas 选题生成与编辑）
- [x] 任务2：Content Agent 交付（commit 0fd65d4 + ce894a0 生图四通道与产品图；excellent+remix、generation、history、admin）
- [x] 任务3：按序合并（Core→Insights→Content，BLOCKED.md 冲突已手工合并）+ 删除旧入口（public/index.html/app.js/styles.css/landing-v3.css/admin.*/js；根 check 脚本去掉 public 引用，commit 42ed604）
- [x] 任务3：旧前端契约测试迁移（18 个失败测试同强度迁到 Vue 实现；commit 0edaf1b；root 388/388、integration 176/176、frontend 135/135，跳过均 0，总数 523 ≥ 基线 521；6 条缺口已上报 BLOCKED.md）
- [x] 任务3：性能收口（系统中文字体栈、无 Google Fonts；首屏图 eager+fetchpriority、非首屏 lazy；预算脚本 PASS：官网 15.4KB/100KB、工作台 39.5KB/250KB、10 路由懒加载、官网无 Vue chunk）
- [x] 任务3：部署流程更新（scripts/deploy-server.sh：干净区→拉 master→双 npm ci→临时目录构建原子切换→check/test/integration/frontend/budget→pm2 restart→四路径烟测，失败前置中止；README 部署章节同步；deploy/nginx 全量代理 Node 无需改）
- [x] 完成条件：双 Node 验证 + 红绿灯演示 + 最终提交（见下）

## 验收证据（对话已贴实际输出）
- 开发机 Node 24.11.1：npm ci ✓、check ✓、npm test 388/388、integration 176/176、frontend 135/135（跳过均 0）、build ✓、budget PASS、三入口+SPA刷新+favicon 烟测全 200、官网无 base/app chunk。
- 真实 Node 20.20.0（D:\Tools\nvm\v20.20.0，独立 worktree .worktrees/node20）：npm ci（后端+前端）✓、check ✓、node --test tests 388/388、integration 176/176、frontend typecheck 0 错误、vitest 135/135（跳过均 0）、build-frontend 原子替换 ✓、budget PASS。
- 红灯→绿灯演示①（预算）：官网 main.ts 强行 import vue → budget FAIL（landing shares chunk … must not load Vue，exit 1）；还原后 PASS。
- 红灯→绿灯演示②（原子替换）：landing 注入 TS 类型错误 → build 在 typecheck 阶段失败 exit 1、dist/public 未被触碰（untouched=True）；还原后 build exit 0。
- 测试总数：root 388 + integration 176 + frontend 135 = 699（原生前端 68 个契约用例已 1:1 迁入 frontend），跳过 0；均 ≥ 基线。

## 决策与“建议”替换记录
- 依赖精确版本（均经 registry engines 核验兼容 Node 20.20.0 与 24.11.1）：vue@3.5.40、vue-router@4.6.4、pinia@3.0.4、vite@7.3.6、@vitejs/plugin-vue@6.0.8、typescript@5.9.3、vue-tsc@3.3.8、vitest@4.1.10、@vue/test-utils@2.4.11、happy-dom@20.11.1、@types/node@20.19.43。
- 选 vue-router@4 + pinia@3 而非最新 5/4 大版本：5.x/4.x 发布过新且互相强绑（router5 peer 要求 pinia3/4+vite7/8），成熟线风险更低；engines 均无限制。
- 选 vite@7.3.6 而非 8.1.5：8 为最新大版本生态验证不足；两者 engines 相同（^20.19.0 || >=22.12.0），vitest4/plugin-vue6 同时兼容 6/7/8，后续升级不受阻。
- “浏览器测试”基础设施：沿用仓库既定的 Kimi WebBridge 浏览器验收门（AGENTS.md），不引入 Playwright 重依赖；单元/组件测试用 vitest+happy-dom；三入口烟测走 HTTP 探测。原因：减少新增二进制依赖对服务器 Node 20.20.0 环境的风险。
- 旧 /assets/* 非哈希图片（logo、landing 图、favicon、二维码）继续由 public/assets 提供：构建时合并复制进 dist/public/assets，避免在 frontend/ 重复提交 6MB 二进制。
- 工作台外壳（WorkspaceShell/Home/NotFound）按“公共组件”由总控实现并冻结在 src/app/，Core Agent 不需要改公共 router 即可完成登录/品牌/个人 IP 迁移。
- worktree 建在仓库内 .worktrees/（已 gitignore）而非仓库外：文件工具沙箱禁止写 workspace 之外的路径。遗留空目录 D:\download\pic-vec\redbase-wt-{core,insights,content} 已从 git 注销但沙箱无法删除文件夹，可手工清理。
- Node 20.20.0 验证在 .worktrees/node20 中用 D:\Tools\nvm\v20.20.0 的 node.exe 直接执行（不经 npm run）：本机沙箱会把 npm run 子进程的 `node` 解析到 PATH 上的其他版本，直接二进制才能保证真实 20.20.0；该 worktree 已 `git worktree remove` 注销登记，目录含 node_modules 沙箱删不掉，可手工清理。
- 集成验收轮次：第 1 轮发现 18 个旧前端契约测试红灯（旧入口删除所致）→ 同强度迁移；第 2 轮全部绿灯。共用 2/3 轮。

# PROGRESS — 趋势交付记录（来自 origin/master）

任务来源：趋势“结果必达”改造（分支 `codex/trend-delivery-guarantee-v1`）。
断线恢复：先读本文件，禁止重做已完成项。

## 任务 0 基线（已完成 2026-07-27）

- worktree 说明：当前 checkout 已在目标分支 `codex/trend-delivery-guarantee-v1`（HEAD=origin/master=`0ff96b5a`），`git status --short` 干净，故直接使用本 checkout 作为工作树，未另建 worktree（“单独 worktree”为建议项，此处环境等价且避免 Windows 下双份 node_modules）。
- `git rev-parse HEAD` → `0ff96b5ae5ff6f025b1724918387fb8aaa9e5c02`（与规划一致；fetch 后 `origin/master` 同 SHA，无漂移）
- `node -v` → v24.11.1；`npm -v` → 11.13.0
- `npm run check` → 通过
- `npm test` → tests 433 / pass 432 / fail 1 / skipped 0 / 10536ms
  - 唯一失败：`tests/text-provider.test.js:283`，探针证实为 Windows/Node24 定时器粒度导致的计时敏感环境性失败（attempt2 在共享 90ms 预算耗尽后才唤醒）。已按等比放大时间刻度修复（语义不变：重试共享一个超时预算、不得获得新预算），修复后连续 3 次 fail 0。
- `npm run test:integration` → 176/176 / skipped 0 / 9444ms
- `npm run eval:ai` → 126/126 / skipped 0 / 6931ms
- 跳过数基线：0。

## 任务 1 搜索干净化（已完成）

- `buildAnySearchQueries`：新增 1 条品牌名/产品精确查询（`buildBrandPreciseQueryText`），品类/人群/维度宽查询不再要求品牌名；药品-流量画像跳过精确查询（安全边界，避免查询含产品/用药词）。
- 取消 `isMarketingEvidenceRelevant`/`isTrafficMarketingEvidenceRelevant` 的整批硬删；保留 URL/私网/坏页/药品安全过滤。相关性降级为候选上的 `brandRelevant`/`trafficRelevant` 信号。
- 候选池：`fetchAnySearchEvidence` 返回 `candidates`（默认上限 30，`rerankCandidateLimit` 可调），供 reranker 使用。
- 新建 `src/server/ai/trend-evidence-reranker.js`：低温 0、maxAttempts 1、4096 tokens；输出 ≤10 个去重槽位 `evidenceIds/topic/bucketFit/brandFit/brandLink/allowedClaims/avoidClaims`；模型失败/空结果回退 `buildDeterministicEvidenceSlots`（有相关候选时绝不选完全无关项）并附 `EVIDENCE_RERANK_FALLBACK/EMPTY` warning，不中止主流程。
- `TREND_RERANK_MODEL`/`textProvider.rerankModel`（config.js）：未配置时复用主模型，同一文本服务。
- 兼容决策：测试注入 `textModelImpl` 且未提供 `rerankModelImpl` 时跳过模型重排、沿用既有证据顺序（保持 60+ 既有生成测试语义稳定；生产路径默认走重排）。

## 任务 2 单条验收、结果必达（已完成）

- XHS/Pgy：单次主模型调用；跳过重复度/自评分/证据重合/泛化文案/强度词业务门禁；仅安全+结构问题本地清理（`getXhsPgyDeliveryIssues`：硬断言/品牌高危声明/药品安全/行内 S 编号 + 缺字段），不足 10 条按 Pgy 笔记顺序补齐（`fillXhsBucketsFromPgy`）；模型调用失败/不可解析也走 Pgy 补齐，禁止二次整批调用。
- 其余五类：主生成 1 + targeted repair 1（循环 `generationAttempt >= 1` 即止）；修复调用失败不再抛错（catch 内 break→本地降级）；剩余问题走 `applyLocalDeliveryDegrade`：安全问题剥离句子/换中性文案（`trend-result-normalizer.js`），结构问题本地补齐，warning-only 问题保留原卡+warning；不足 10 条用证据槽位 `buildFallbackTrendCard` 补齐；清理后仍不安全的卡整卡替换为降级卡。
- 逻辑调用上限：XHS 1；其他 3（重排1+主生成1+修复1），共享 `ai-call-budget`（上限 5，未改）。
- `TREND_MODEL_VALIDATION_FAILED` 仅在“无模型条目且无证据可降级”时抛出；预算耗尽且零产出时仍抛 `TREND_AI_CALL_BUDGET_EXCEEDED`（不扣积分）。
- 收口更新（2026-07-27 第二轮）：非 XHS 维度在 AnySearch 已有可用 evidence/slots 时，即使主模型第一次调用发生传输级异常、超时或零产出，也用证据槽位本地生成恰好 10 条降级卡并附 `TREND_MODEL_UNAVAILABLE` + `TREND_ITEM_FALLBACK` warnings，走现有成功事务扣 1 次积分；只有搜索来源本身为空时才失败不扣分。（此前“首调传输失败仍失败”的决策已废除并从 BLOCKED 移除。）

## 收口轮（2026-07-27 第二轮，在 .worktrees/trend-delivery 执行）

- reranker `normalizeModelSlots`：接受模型槽位前再次调用 `isCandidateRelevant(candidate, bucketKey)`——模型选中真实存在但 brandRelevant=false 且 trafficRelevant=false 的候选时直接丢弃，不再只过滤不存在的编号。
- 确定性 fallback `buildDeterministicEvidenceSlots`：候选不足 10 条时，同一来源按 `SLOT_ANGLE_VARIANTS`（用户提问整理/内容形式观察/场景案例拆解等）拆成不同且明确的场景/内容形式槽位；topic 全批唯一（冲突兜底追加槽位号）；发生来源复用时由 `buildRerankedEvidencePlan` 附 `EVIDENCE_SLOT_REUSED` warning。
- 新增回归：首调传输异常（服务级 ETIMEDOUT + API 级 ECONNRESET 经真实服务端到端扣 1 分）、rerank 模型选真实无关候选 C3 被丢弃、2 个相关候选时 10 槽位 topic 全唯一（fallback 附 reuse warning）；更新旧契约测试“截断响应→整体失败”为“截断响应→10 张降级卡”。

## 任务 3 warnings 透出（已完成）

- `generateTrendBucketGroup` 返回 `attachAnalysisWarnings(trendBuckets, analysisWarnings)`（真实 warnings）；metrics 增加 `warningsCount`。
- `trend-routes.js`：成功响应 `warnings: analysisWarnings`；分析记录写入 `warnings` 字段（注：DB schema 不可改，snapshot 归一化会丢弃该字段，replay 时读不到则回空数组；replay 核心语义“不重复扣分”不受影响）。
- 前端 `notifyTrendAnalysisWarnings`：成功后用现有 `showToast` 非阻断提示“已返回 N 条，其中 M 条为待验证/降级内容”；失败 alert 仅剩真实失败路径。styles.css 未改（复用现有 app-toast 样式，避免布局改动）。
- 积分：降级成功走 `completeTrendAnalysisRequest` 扣 1 次；真失败 `failTrendAnalysisRequest` 不扣；requestId 幂等复用既有机制。

## 任务 4 回归测试与说明（已完成）

- 新建 `tests/trend-delivery-guarantee.test.js`（11 用例）：确定性槽位不选无关项；重排失败降级+warning；模型槽位校验/去重/S 映射；TREND_RERANK_MODEL 覆盖；生成计划槽位锚点；六 bucket 各返回恰好 10 条；7 合格+3 不合格只修 3 条；修复模型故障仍 10 条+warning；1 条重复不沉整批；XHS 短批 Pgy 补齐；XHS 完全不可解析降级 10 卡。
- 新建 `tests/trend-delivery-credits.test.js`（3 用例）：降级成功扣 1 次+warnings 透出+相同 requestId 重放不重复扣；真失败扣 0 次；降级批分析记录含完整快照。
- 更新 `tests/anysearch-integration.test.js` 8 处到新契约（fixture 查询编号对齐 5 查询布局；XHS 单调用；非 XHS 两调用+本地降级；完全不可解析→降级卡）。理由：这些断言锁定的是本次任务明确要求废除的“整批一票否决”行为，属行为契约变更而非放宽（新断言同时验证更强的“必达 10 条+warning”契约）。
- README：TREND_RERANK_MODEL 配置、三阶段链路、单条验收/降级/积分行为说明。
- 反向验证：临时让 `applyLocalDeliveryDegrade` 抛错 → `tests/trend-delivery-guarantee.test.js` 3 个目标用例红（六 bucket 必达 / 修复故障必达 / 重复不沉批）；还原后 14/14 绿。临时破坏未提交。

## 最终验收数字（改动后）

- `npm run check` → 通过
- `npm test` → tests 447 / pass 447 / fail 0 / skipped 0（基线 433→447，只增不减；跳过 0 不高于基线）
- `npm run test:integration` → 176/176 / skipped 0
- `npm run eval:ai` → 126/126 / skipped 0
- `git diff --check` → 通过（exit 0）
- 无新依赖（package.json/lockfile 未动）、无 schema/migration/积分事务仓库改动。

## 待办

- [x] 任务 0 基线
- [x] 修复 text-provider 计时敏感测试
- [x] 任务 1 搜索查询调整 + reranker
- [x] 任务 2 单条验收、targeted repair、降级必达
- [x] 任务 3 API warnings + 前端提示 + 积分
- [x] 任务 4 回归测试 + README + 反向验证（红→绿）
- [x] 分三段提交（搜索重排 `7e2a87a` / 结果交付 `36496b2` / API与测试 `d3ca478`）+ verify-change.ps1 全绿（另以 `-RiskOverride R2` 跑过 static+unit+integration 全命令泳道）+ 分支已推送 `origin/codex/trend-delivery-guarantee-v1`，未合并 master
