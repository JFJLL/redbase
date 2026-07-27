# PROGRESS

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
