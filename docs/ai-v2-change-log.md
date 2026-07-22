# RedBase AI Pipeline v2 — Change Log

发布分支：`feature/redbase-ai-v2`  
整理日期：2026-07-22  
性质：发布前合并整理（不新增功能）

本分支吸收并收敛了：

1. `trend-pipeline-rebuild`
2. `trend-prompt-engineering`
3. `image-prompt-engine`
4. `ai-observability-and-evaluation`

---

## 1. 新增能力

### 1.1 Brand Intelligence（品牌智能层）

- 模块：`src/server/ai/brand-profile-builder.js`
- 在趋势分析前，从品牌档案确定性推导结构化品牌理解：
  - `brand_position`
  - `consumer_problem`
  - `purchase_trigger`
  - `competitive_advantage`
  - `content_boundary`
  - `tone_style`
- 行业模板覆盖：医药、咖啡、宠物、母婴、美妆等；医药/高风险场景有安全兜底。
- **不调用模型、不写库**；相同品牌字段始终得到相同输出。

### 1.2 Market Signal Extraction（市场信号抽取）

- 模块：`src/server/ai/trend-signal-extractor.js`
- 将 AnySearch / Pgy 证据转成可进入 prompt 的信号：
  - keyword / change / consumer_language / consumer_need / confidence
- 过滤空话套话，去重并按置信度排序。
- **不调用模型**；证据 → 信号是纯规则路径。

### 1.3 Image Prompt Engine（图片提示词引擎）

- 模块：`src/server/ai/image-prompt-builder.js`
- 用固定五层结构替换自由 AI 图片 prompt：
  1. 视觉目标
  2. 品牌调性
  3. 场景
  4. 构图
  5. 负面约束
- 内容类型模板：`product_seed` / `cover` / `poster` / `detail_page`
- 编辑图（`editPrompt` / `skipStructuredPrompt`）保留用户原文。
- **不调用模型**；相同输入始终同一 prompt。

### 1.4 AI Observability & Evaluation（可观测与评测）

- 模块：`src/server/ai/evaluation.js`
- 记录每次趋势分析 / 图片生成 run：
  - task / model / prompt_version / latency / success / metadata
- 人类质量分（1–5）与 run 分离存储，避免并发评分覆盖生成记录。
- 支持按 `prompt_version` 对比平均质量；自动粗分仅作 metadata 提示，不污染人类分。
- 落盘路径默认 `data/ai-evaluation-runs.jsonl`（已在 `data/` gitignore 内）。

### 1.5 Trend Guardrails 强化

- 模块：`src/server/ai/trend-guardrails.js`
- 与趋势 prompt 工程协同：无来源硬声明、空话机会卡、自评分门槛等校验。
- 失败时走有界 targeted-repair / 全量重试，不做无限循环。

---

## 2. 架构变化

### 2.1 趋势链路（单一主路径）

```
AnySearch / Pgy
    ↓
Evidence
    ↓
Signal Extraction          (trend-signal-extractor, 确定性)
    ↓
Brand Intelligence         (brand-profile-builder, 确定性，每轮一次)
    ↓
Trend Generation           (text-provider 单次主生成)
    ↓
Guardrails + bounded repair
    ↓
Evaluation record          (旁路，失败不阻断主流程)
```

### 2.2 图片链路（单一主路径）

```
Brand Intelligence 上下文
  + Content Objective / contentType
    ↓
Image Prompt Builder       (确定性五层 prompt)
    ↓
Image Provider             (WaveSpeed / RunningHub)
    ↓
Evaluation record          (旁路)
```

### 2.3 模块职责边界

| 模块 | 职责 | 模型调用 |
|------|------|----------|
| `brand-profile-builder` | 品牌智能 | 否 |
| `trend-signal-extractor` | 证据→信号 | 否 |
| `trend-guardrails` | 校验与评分规则 | 否 |
| `image-prompt-builder` | 结构化图片 prompt | 否 |
| `evaluation` | 观测与人类评分 | 否 |
| `trend-service` | 编排趋势主流程 | 是（文本） |
| `image-jobs` | 编排图片主流程 | 是（图片 provider） |
| `text-provider` | 文本模型客户端 | 是 |

### 2.4 重复实现检查结论

| 能力 | 实现位置 | 结论 |
|------|----------|------|
| brand-profile-builder | 唯一：`brand-profile-builder.js` | 无重复 |
| trend prompt / signals | `trend-service` + `trend-signal-extractor` + `trend-guardrails` | 职责分离，无第二套 |
| image prompt builder | 唯一：`image-prompt-builder.js`，由 `image-jobs` 接入 | 无重复 |
| evaluation hook | 唯一：`evaluation.js`，trend / image 各旁路记录 | 无重复 |

### 2.5 调用链健康检查

- **无循环依赖**：叶子模块（builder / extractor / guardrails / evaluation）互不 require。
- **无无意义二次生成**：Brand Intelligence / Signal Extraction / Image Prompt 均为确定性、每轮一次；模型二次调用仅发生在 guardrails 失败后的有界 repair。
- **无重复模型预热路径**：信号与品牌层不占模型预算。

---

## 3. Prompt 变化

### 3.1 趋势 Prompt

- 注入 Brand Intelligence 策略段（定位/场景/边界/调性），明确「策略参考 ≠ 可编造产品事实」。
- 注入 Market Signals 块，驱动「信号 → 营销机会」而非空话热点。
- 系统提示要求品牌优势 / 场景 / 红海判断标准。
- 医药流量场景：品牌别名遮罩 + 安全 intelligence，禁止功效/剂量/诊疗表述。
- 证据与品牌档案分离：档案只定身份与边界，时效与事实以本次证据为准。

### 3.2 图片 Prompt

- 从自由生成文案改为固定五层商业模板。
- 共享负面约束：廉价电商图、白底抠图、硬广标语、过度修图等。
- 模板按 `contentType` 分化构图与场景焦点，同产品不同模板输出可区分。

### 3.3 Prompt 版本标签（evaluation）

- `trend_analysis` → `trend-v1`
- `image_generation` → `image-v1`  
  后续重大 prompt 变更应 bump 版本以便 `comparePromptVersions`。

---

## 4. 已知限制

1. **信号抽取是规则引擎**  
   依赖标题/摘要关键词与模式匹配；对口语化、跨句暗示的信号覆盖有限，可能漏信号或泛化。

2. **Brand Intelligence 无模型增强**  
   行业模板与档案文本拼接；冷门行业会落到 generic 模板，精细度低于定制人工 brief。

3. **图片引擎不读视觉参考图**  
   仅文本结构化 prompt；产品外观一致性仍依赖 provider 与参考图上传能力。

4. **Evaluation 本地 JSONL**  
   适合单机内测；多实例/多机部署时需自行考虑集中存储与并发策略。人类评分 API 若未暴露到运营台，则依赖脚本/测试调用。

5. **有界模型重试仍有成本**  
   Guardrails 失败会触发 targeted-repair 或有限次全量重生；极端脏输出仍可能整次失败并退款/不扣费（既有积分策略）。

6. **AnySearch / 外部依赖**  
   网络、配额、CDN 边缘故障时趋势分析 fail-closed（无证据不生成），需运维侧保证密钥与预算配置。

7. **文档目录 gitignore**  
   仓库 `.gitignore` 含 `docs/`；本 changelog 需 `git add -f` 纳入版本控制（与既有 docs 一致）。

---

## 5. 验证快照（整理时）

| 命令 | 结果 |
|------|------|
| `npm run check` | pass |
| `npm test` | 252 pass / 0 fail |
| `npm run test:integration` | 135 pass / 0 fail |

---

## 6. 主要文件清单

**新增**

- `src/server/ai/image-prompt-builder.js`
- `src/server/ai/evaluation.js`
- `tests/image-prompt-builder.test.js`
- `tests/evaluation.test.js`
- `docs/ai-v2-change-log.md`

**主要修改**

- `src/server/ai/trend-service.js` — 信号层 + brand intelligence + evaluation 旁路
- `src/server/ai/trend-guardrails.js` — 质量门
- `src/server/ai/image-jobs.js` — 结构化 prompt + evaluation
- `src/server/ai/brand-profile-builder.js` — 品牌智能（既有提交）
- `src/server/ai/trend-signal-extractor.js` — 信号抽取（既有提交）
- `package.json` — `npm run check` 覆盖新模块
- `tests/trend-signal-pipeline.test.js` — 管线回归

---

*本文件为 AI v2 发布整理说明，不构成对外产品承诺。*
