# PROGRESS

## 任务：Vue 迁移闭环发布阻塞修复（2026-08-05，分支 codex/vue-migration-closure-20260805）

### 任务0 基线核对

- 分支 `codex/vue-migration-closure-20260805`，HEAD `a9fad7cc9ee84acef41e88971424c877f3426c5f`，33 项未提交改动全部保留（21 M + 1 D + 13 ?? 中的受跟踪/未跟踪组合，与交接一致）。
- 交接冻结 patch SHA256 `72405f93…` 复核一致；CodeGraph 定点核对 `buildRecoverableImageJobSnapshot`（无签名）与 active 路由（未接 signLocalAssetUrls）属实。
- 基线：后端恢复测试 12/12、前端恢复/深链/改图 23/23 通过。

### 阶段1 红→绿：active 恢复 payload 本地图片签名

- 红：新增契约测试（真实 `/api/generated-images/8801/slides/0/file` 路径 + 真实 PNG 文件 + 同一 appConfig 真实验签），断言本地 URL 带签名、未签名 401、签名 200、CDN 不改写、provider 不泄露；修复前 12/13（签名断言红）。
- 修复：`GET /api/image-jobs/active` 改为 `signLocalAssetUrls(jobs.map(buildRecoverableImageJobSnapshot), appConfig)`，复用现有签名机制，资源路由验签强度零改动。
- 绿：13/13；红绿证据 `outputs/red-green-active-signing.txt`。期间发现并如实记录两点实现细节：本地资源文件必须符合 `assertGenerationAssetOwnership` 的 `gi_<generationId>_` 命名约束（安全设计）；`handleHistoryRoutes` 的 `serveStoredGeneratedImage` 依赖上层注入 storage（与 src/server/api.js 生产接线一致）。

### 阶段2 真正并发与 credit-event 关联测试

- 单图“两标签”改为真实 `Promise.all`（原顺序调用），断言同 generationId、恰好一行历史、job 关联持久化；failed 退款改 4 路 `Promise.all`，断言无 500、恰好一次退款事件、积分只恢复一次、job refund marker 与退款事件一致。
- 两个并发用例（9301/9302）使用真实非空 creditEventId，断言 credit event `generation_id` 关联正确 generation 且 payload 携带 generationPayload；9001 断言退款关联。
- 12 个既有测试语义全部保留，测试数 12→13 不降。

### 阶段3 证据纠正与隔离浏览器复验

- 浏览器证据重写为两段式：第 0 节如实披露初跑误触一次真实 RunningHub（费用/任务/数据保留状态列为用户人工核对项，不猜测已清除）；第 1-4 节为整改后隔离复验（一次性 DB + 本地 health 轮询 + `node -r outputs/outbound-fail-fast.cjs` 出站 fail-fast，非回环请求进程内直接失败）。
- Kimi WebBridge 真实 Chrome 复验：组内“一页完成（本地签名图）一页运行（本地 health 轮询）”，登录→刷新→退出重登三个检查点全部通过（active 200、回填在、签名形状正确、签名 URL fetch 200 image/png、img naturalWidth=1、无 provider 泄露）；横幅显示「组图正在恢复（1/4）」；截图 `kimi-recovery-signing-banner.png`。
- 网络捕获 110 条：0 创建 POST、0 真实出站（仅 127.0.0.1 + 浏览器扩展噪音）；过滤摘要 `artifacts/verification/kimi-recovery-network-2026-08-05.json`。
- evidence.json note 与证据文件同口径（含初跑误触披露）。

### 阶段4 全量验证与 fresh-context 独立审查

- 全量确定性验证通过：check / unit 613 / integration 266 / data 31 / typecheck:frontend / frontend 292 / build / budget PASS / eval:ai 126 / smoke:api ok（隔离 DB、无真实 AI、出站 fail-fast）。
- 冻结完整 diff（含 13 个未跟踪文件）：`artifacts/verification/frozen-diff-bdcc77d81b07f64f88b8ad2e11a62ed74cfb5bc50f37a7f040b4112847765af5.patch`，SHA256 `bdcc77d8…`；fresh clone 应用 check=0/apply=0，33 文件 CR 归一化后 0 差异（16 个字节级差异为 Windows CRLF 噪声）。
- 全新 reviewer（agent `019fd242-8633-7481-ba21-c248a6cbfdc1`，昵称 Bacon，`fork_turns=none`，未设置模型/推理覆盖，只读）：**APPROVE-WITH-CONCERNS，无 blocker/major**；2 条 minor（PM2 实例数人工核对项；evidence note 建议补初跑事实——已按建议更新）。原始输出 `reviewer-7-bacon-raw-output.md`，状态证明 `review-state-r3.json`。
- 审查前/后 `git status --porcelain=v1` SHA256 均为 `A73AA9D35160E315680DD0E4AF1ED09660669426EABA4FBD7C2B16AFF905B446`，前后一致，reviewer 零写入。
- 该轮 `verify-change.ps1 -RiskOverride R3` 曾以当时工作区 fingerprint `b39fe27f…` 通过；后续账本与 P1 修复已使该值仅保留为历史记录，当前发布指纹以 `.verification/receipt.json` 和 `-CheckReceipt` 实测为准，不再在账本中宣称旧值是“最终 diff”。
- 未提交、未推送、未合并、未部署；一次性 DB/图片文件已删除；无真实服务调用（除已披露的一次初跑误触）。

### 部署契约核对

- 仓库内 deploy/ 仅 nginx 配置（单上游 127.0.0.1:3013）；`scripts/deploy-server.sh` 为 `pm2 restart redbase`；无 ecosystem/cluster/instances 配置；server.js 单进程。仓库侧未发现 cluster 或多实例配置，不写 BLOCKED.md。
- 生产 PM2 实例数无法从仓库核实 → 发布前人工核对项：服务器执行 `pm2 jlist`/`pm2 describe redbase` 确认 `exec_mode: fork` 且 `instances: 1`。

### 阶段5 第八轮独立审查发现并修复 P1（2026-08-06）

- 第八轮 fresh-context reviewer（`/root/final_p1_release_review`）审查包含 PROGRESS.md 的 34 项补丁，结论 `REQUEST-CHANGES`：发现 2 个 major（仿图文弹窗上传/认领后素材模式未同步，真实生成静默丢产品图；历史组图默认入口缺 slideIndex、稀疏页过滤后使用错误下标）和 3 个 minor。该结论在修复后自动失效，等待全新 reviewer。
- 红阶段：新增真实入口测试后 4 项失败——上传/认领后 slide POST 为 0/未带产品图；组图默认改图未发 `slideIndex: 0`；稀疏组图没有原始第 4 页页签。
- 绿阶段：上传/认领成功后同步 `assetMode` 并使旧融合方案失效，四个真实 slide POST 均携带选中产品图；所有异步返回按发起时品牌复核，切换品牌后旧响应不污染新品牌；历史页展示模型保留 `sourceIndex`，默认选择第一张真实页，稀疏页按原始下标改图。定向测试 11/11 通过。
- 产品图删除确认、全选题引用清理、三类单图继续改图、历史普通图/改图结果父链均复核保持通过；单实例限制仍为发布前人工核对项。
- 下一步：跑全量 R3、冻结新的完整 diff、启动全新第九轮 reviewer；最终 reviewer 后禁止再修改受跟踪文件。

## 历史任务（以下为先前记录）

## 任务：独立复验 P0 阻塞修复（2026-08-04，继续 codex/fix-vue-ui-regressions，未提交工作区保留）

### 任务0 取证

- 独立复验发现两个发布阻塞项；当前 `.verification/receipt.json` status=fail（指纹 31f33a30），-CheckReceipt 失败。
- P0-1 启动清理测试依赖真实 OSS：`tests/server-history-cleanup-startup.test.js` 只隔离了 DB/PORT，未隔离 config.local.json 的 aliyun_oss；`cleanupExpiredGenerationHistory`（history-routes.js）中 cleanupDeletionStaging/cleanupUnreferencedAssets/cleanupStagedStoredAssets 三个恢复步骤 await 无 try/catch，OSS 请求失败会提前终止整个函数，无资产过期记录 8801 不被删除 → 断言失败（本机网络可达时偶然通过 597/597，不可达时 596/597）。`start()`（index.js）已把整个 cleanup 包 try/catch 但只 warn，不补救扫描。
- P0-2 图库失败仍可空素材生成：`startGenerationAction`（共享入口，自动/手动/重试共用）在检查图库状态前就 `consumeActionTicket()` 并执行生成；四个按钮只 `:disabled="busy"`；generationAutoStart.test.ts 现有用例明确允许图库失败后手动点击产生 1 次 POST（productImages: []）。auto 路径的 maybeAutoStartGeneration 也未考虑 useProductImages=false 时应放行。
- 处理：子代理 A（后端 P0-1）、子代理 B（前端 P0-2）并行，先红后绿；主线程最后全量验证 + receipt。

### 修复完成（2026-08-04）

- P0-1（子代理 Parfit）：`cleanupExpiredGenerationHistory` 三个恢复步骤（cleanupDeletionStaging/cleanupUnreferencedAssets/cleanupStagedStoredAssets）各自 try/catch（runRecoveryStep，warn 仅 errorCode/status），失败不再阻断过期记录扫描；逐条删除安全顺序保留（资产删除失败 → failedGenerationIds、行保留）。红 3 失败 → 绿 3/3（tests/history-cleanup-recovery.test.js）。启动测试双层隔离：require 前置空 ALIYUN_OSS_* 环境变量（provider 回退 local）+ http/https request/get 四入口打桩，start() 期间任何出站请求直接 fail（证明不发网络请求）；启动/监听/close/8801 删除断言保留，4/4。既有 history-routes 10/10、generation-retention-oss 12/12。红绿记录 outputs/red-green-p0-cleanup.txt。
- P0-2（子代理 Goodall）：`startGenerationAction` 在 consumeActionTicket 之前检查 `productLibraryBlocked = useProductImages && (!productImagesLoaded || !!productImagesError)`，命中即 return（不发 POST、不消费票据、显示错误+引导重新加载）；四个生成按钮与重试按钮 `:disabled="busy || productLibraryBlocked"`；maybeAutoStartGeneration 按 useProductImages 分流（关闭时不再等图库）。红 2 失败 → 绿 39/39（generationAutoStart 8→11 用例，覆盖：图库失败手动 0 POST+action 保留、重试成功 1 POST+素材完整+action 移除、关闭产品图时 1 POST 允许、刷新/后退前进/失败重试不重复）。红绿记录 outputs/red-green-p0-product-library.txt。
- 全量验证：check / unit 600 / integration 253 / data 31 / typecheck / frontend 235 / build / eval:ai 126 / smoke:api ok（首次即过，seed 计数器修复保持），skip/todo 0，测试数全部不低于基线。npm test 从复验时的 596/597（环境相关）恢复为确定性 600/600。
- 浏览器复验（Kimi）：一键进入 1 POST → 刷新 0 新增 → 手动点击恰 +1；图库就绪后按钮恢复可用；上下文与视觉无回退。证据 kimi-browser-round3-evidence.md。
- verify-change R3 七通道全通过，receipt status=pass，fingerprint=`aa682d6fc9e14f3dd716fcd04b1ac2ecccafd10dc0d484c2613c03bf026b20b1` 与最终 diff 一致，-CheckReceipt 通过，git diff --check 干净。
- 未提交/推送/部署；未改真实数据/配置；范围外候选（api.js appConfig 接线、代理 3xx、coverUrls 消费）按任务书要求本轮未扩大修改，仍记录在 BLOCKED.md。

## 任务：独立复审 4 缺陷修复（2026-08-04，继续分支 codex/fix-vue-ui-regressions，未提交工作区保留）

### 任务0 现状与取证

- 上一轮工作区 26 个文件未提交，全部保留；R3 receipt 曾以指纹 09c95320279bd5edce9c10932b54ff8c19137265a37e3d1068a44bc8d0910768 通过。基线 unit 586 / integration 242 / data 31 / frontend 224 / ai-eval 126，skip/todo 0。
- 复审确认的 4 个缺陷（逐一读码取证）：
  1. image-store.js `buildPgyImageRequestHeaders(appConfig)` 无目标 URL 参数，配置 Pgy Cookie 后对任何域名（含 COS/RunningHub/evil）都附带 Cookie；`fetchRemoteImageBytes` 跨跳转复用同一 headers。
  2. 历史远程回退响应 `Cache-Control: public, max-age=600`；优秀内容代理 `public, max-age=3600`，均可被共享缓存绕过登录。
  3. 代理取图只从 `item.imageUrls` 取索引，而响应重写覆盖 coverUrl/primaryCoverUrl/coverUrls；cover-only 记录代理 404，多图时封面索引可能错位。
  4. GenerationView 保留 action 查询参数，`startedActionKey` 仅防同挂载重复；刷新/重挂载会再次自动 POST；自动 POST 早于 ProductImagePanel images-loaded，useProductImages=true 且已选产品图时首包为空数组。
- 处理：子代理 A（后端缺陷 1-3，先红后绿）、子代理 B（前端缺陷 4，先红后绿）并行；主线程最后全量验证 + Kimi 无回退验收 + 全新上下文独立审查子代理出 agent-review 证据。

### 修复完成（2026-08-04）

- 子代理 Copernicus（后端）：`isPgyCookieDomain(host)` + `buildPgyImageRequestHeaders(appConfig, targetUrl)` 按目标域名附加 Cookie；`fetchRemoteImageBytes` 每跳重建头、跨域跳不继承 Cookie；历史回退与优秀内容代理 Cache-Control 均改 `private, max-age=300`；新增 `normalizeExcellentImageSequence(item)`（imageUrls→coverUrls→coverUrl→primaryCoverUrl 合并去重），响应重写与代理取图共用，cover-only 记录代理 200、多图索引不错位。红：11 失败（public 缓存、Cookie 泄漏、cover-only 404、重定向继承）→ 绿：28/28。记录 outputs/red-green-review-fixes-backend.txt。
- 子代理 Bacon（前端）：`consumeActionTicket()` 在任何生成 POST 前 router.replace 移除 query.action（失败则停止并显示可恢复错误，不重复 POST）；`maybeAutoStartGeneration()` 门控等待品牌上下文+创作设置恢复+产品图库 images-loaded，图库失败显示可恢复错误不静默空素材生成；首包产品图 {id,name} 完整。红：6 失败 → 绿：35/35（新 7 用例）。记录 outputs/red-green-review-fixes-frontend.txt。
- 主线程：修复验收环境 seed 脚本计数器（nextBrandId 等未同步 max(id)+1 导致首次建品牌撞主键，属验收脚本问题非产品缺陷）；全量命令通过：check / unit 597 / integration 253 / data 31 / typecheck / frontend 231 / build / eval:ai 126 / smoke:api ok，skip/todo 0，测试数全部不低于基线。
- Kimi 无回退验收（隔离 DB + fake SMS）：登录视觉、优秀内容 8/8（naturalWidth 1080）、历史 4/4（880/768）、图4 双列选题卡、生图空状态全部保持；一键朋友圈图：点击后 URL 即移除 action，恰好 1 个 POST，刷新/返回/前进 0 个新 POST；两处图片接口实测 `Cache-Control: private, max-age=300`。截图 kimi-round2-*.png。

### 待办

- 独立审查子代理出 agent-review 证据 → evidence.json → verify-change receipt → CheckReceipt。

### 完成（2026-08-04）

- 独立审查子代理（Dewey，全新上下文、只读、未参与实现）出具 PASS（有条件）证据：7 项要求主体契约全部通过并独立复跑一致；发现 2 个值得修复的问题 + 2 个观察项。
- 问题 2（图库失败+手动点击未消费 action → 重试后二次自动 POST）已修复：`startGenerationAction` 成为共享入口并在任何 POST 前消费票据，四个手动按钮改走该入口；红（2 个 POST）→ 绿（generation 36/36、frontend 232/232、typecheck、build 通过）；修复记录已追加进独立审查证据。
- 问题 1（api.js 生产接线未传 appConfig）与观察项超出本轮允许文件清单，已记入 BLOCKED.md 作为下轮候选，不影响本轮五个复现场景结论。
- 最终验证：verify-change R3 七通道全通过，receipt status=pass，fingerprint=`fb58667cf2cd4cc5c0fc7b8c951fcbd90267962c0bee23d7d6753125c6e439a5` 与最终 diff 一致，-CheckReceipt 通过。未提交/推送/部署；未改真实数据；BLOCKED.md 当前记录为「无阻塞 + 3 个范围外候选」。

## 任务：Vue 前端视觉与图片回归修复（2026-08-04，分支 codex/fix-vue-ui-regressions）

### 任务0 基线核对证据

- 当前仓库 D:\download\pic-vec\redbase-fullstack-latest：干净 master @ 73d54c4；旧版仓库 D:\download\redbase：HEAD b415280、工作区不干净（M package-lock.json、?? scripts/run-tests.cjs），与任务书一致，未清理/覆盖。四张截图均可读（登录/优秀内容破图/生图裸表单/内容选题规格）。
- 从最新 origin/master（73d54c4，fetch 后无新增）建 `codex/fix-vue-ui-regressions`，原名不存在，未覆盖。
- 基线全绿：check pass；unit 569/569；integration 225/225；data 31/31；typecheck:frontend pass；frontend 188/188；build pass；smoke:api `{"ok":true,...,"rechargePlans":0}`（临时 DB `outputs/baseline-smoke.sqlite`，端口 3013，未碰真实数据）；skip/todo 0。
- 注意：smoke:api 需要服务先启动（脚本不自动起服务）；验证时用 `REDBASE_DB_FILE` 指向 outputs/ 一次性 DB。

### 目标 / 顺序 / 最大风险（≤10 行）

1. 目标：登录、内容选题、生图任务、优秀内容、历史生成恢复正式产品品质，图片真实加载。
2. 顺序：任务1 图片链路（优秀内容/历史生成 src→契约测试红→绿）→ 任务2 IdeasView + GenerationView 重做 → 任务3 AuthPanel 视觉 → 任务4 全量验证与 Kimi 证据。
3. 最大风险：签名 URL 过期/401 被当破图；选题上下文在刷新/返回后丢失；生图按钮参数链（brandId/trendId/ideaIndex）断裂；改动超范围（后端/认证逻辑/测试基线）。

### 任务1：图片真实可用（进行中）

- 复现取证（Kimi WebBridge + API，2026-08-04）：
  - 优秀内容：缓存 imageUrls 全部为 https://ci.xiaohongshu.com/... 原始远程图，浏览器直连 8/8 返回 403（XHS CDN 防外链，text/plain，server: Lego Server）；服务端同 URL 请求 200 image/jpeg。根因=缺服务端图片代理。
  - 历史生成：data/redbase.sqlite generation 43（xhsCarousel 4 slides）本地 storedPath 文件在 data/uploads/generated-images 下已不存在，签名 URL 请求返回 404 application/json（破图）；localImage.originalUrl（腾讯 COS）实测 200 image/png 仍可用。根因=本地文件缺失时无真实资源回退。
  - 签名 URL：HMAC 10 分钟稳定桶（最长约 20 分钟），过期 401；前端无刷新机制。
  - 截图/证据：outputs/kimi-repro-excellent-before.png、outputs/kimi-repro-history-before.png；Network 记录在主线程对话。
- 处理：子代理 Sartre（任务1）并行实现服务端代理路由+历史回退+前端签名刷新与错误态，先红后绿。

### 任务2：内容选题与生图流程（待开始）

- 处理：子代理 Carson（任务2）并行实现；规格=图4 + D:\download\redbase 旧版 renderIdeas/styles.css（只读）。

### 任务1/2/3 完成（2026-08-04，三个子代理并行）

- 任务1（Sartre）：服务端图片代理路由 + 历史远程回退 + 前端签名刷新/错误态；红→绿证据 outputs/red-green-task1-image-fix.txt。
- 任务2（Carson）：IdeasView 恢复图4全部控件 + GenerationView 空状态/承接选题；红→绿 outputs/red-green-ideas-generation.txt。
- 任务3（Pasteur）：AuthPanel 验证码同行、SVG 关闭图标、忘记密码文本链接、尺寸统一；红→绿 outputs/red-green-auth-visual.txt。
- 主线程集成发现并修复：IdeasView 深链上下文在首次 loadBrands 的 syncOwner 重置后丢失（浏览器实测选中错品牌）；修 loadPage 在列表就绪后重套 query，新增回归测试，红（AssertionError 选中“第一顺位品牌”）→绿（13/13）。
- 全量验证：check pass；unit 586/586；integration 242/242；data 31/31；typecheck pass；frontend 224/224；build pass；smoke:api ok（临时 DB outputs/repro-final.sqlite，未碰真实数据）。skip/todo 0，测试数全部不低于基线。
- 浏览器验收（Kimi WebBridge，隔离 DB + fake SMS）：优秀内容 8/8 代理 200 image/jpeg（修复前 403）；多图轮播 8/8 资源 200；历史生成 4/4 幻灯片经 COS 回退加载（naturalWidth>0，修复前 404）；注册（新用户进入工作台）/登录/重置（新密码登录成功）三态；图4 选题页双列卡片+全部控件+三按钮积分标签；生图任务侧栏直入=引导空态（裸表单消失）、选题进入=上下文+自动起任务；390 视口无横向溢出（用户已说明移动端暂不作为交付重点）。
- 证据截图与 Network 记录见 artifacts/verification/kimi-browser-image-ui-evidence.md；对抗复核见 agent-review-evidence.md（本环境无第二位 reviewer，由执行 agent 完成并如实注明）。

### 任务3：登录视觉（待开始）

- 处理：子代理 Pasteur（任务3）并行实现；规格=图1。

### 任务4：验证（进行中）

- 确定性通道全部通过（见上）；Kimi 证据已出；待 verify-change 全通道 + receipt。

### 任务4 完成（2026-08-04）

- 全量确定性验证：check / unit 586 / integration 242 / data 31 / typecheck / frontend 224 / build / smoke:api / eval:ai 126 全部通过，skip/todo 0，测试数全部不低于基线。
- verify-change R3 全通道通过（static/unit/integration/smoke/ai-eval/kimi-browser/agent-review），`.verification/receipt.json` status=pass，fingerprint=`931212f369730340239bfd431218eff47b55828b3851dc0249752d099da3bd94` 与最终 diff 一致，`-CheckReceipt` 通过。
- 期间修复 smoke 失败一次（浏览器验收把测试号密码重置，一次性库已改回 123456，非代码问题）。
- 未提交、未推送、未部署；未改真实数据库/上传数据；D:\download\redbase 与截图仅只读；BLOCKED.md 当前为「无」（agent-review 由执行 agent 完成，需独立 reviewer 复验，已在证据中注明）。

### 任务4：验证（待开始）

- 待办：组件/API 回归测试、Kimi WebBridge 截图与 Network 证据、全量命令 + verify-change receipt。

## 当前状态（2026-08-04）

- 规范生产分支：`master`。
- 本次整理前，本地 `HEAD`、`origin/master` 与 GitHub 远端 `master` 均为 `50f8f2d55989a36e34dcd0ae51eeb60fcb23bf45`。
- Vue 前端视觉恢复及此前功能已完成并进入 `master`；本地辅助 worktree 和已被主线吸收的历史分支已经清理。
- 本地 Git 对象已通过 `git fetch --refetch origin` 补齐，`git fsck --full --no-reflogs --no-dangling` 通过。
- 下一项计划：在独立分支和 worktree 中分析并实现短信验证码与支付宝支付；尚未开始源码修改。
- 本次仅整理项目账本，不涉及业务源码、数据库、配置、构建产物或部署。

## 历史记录

2026-07-30 及以前的完整任务记录保存在 [docs/history/progress-through-2026-07-30.md](docs/history/progress-through-2026-07-30.md)。

## 任务：短信注册/找回密码 + 支付宝电脑网站充值（2026-08-04，分支 codex/redbase-sms-alipay）

### 任务0 基线核对证据

- 建库前执行 `rtk git fetch origin` 后：`master`/`origin/master` = `b268625dd5c8d4d56d96b812bdb34d020f9e14bd`，工作区干净，仅一个本地分支。
- 任务书记录的 `50f8f2d` 已过时：该提交存在且是 master 直接父提交，master 仅多一个 `docs: archive completed task ledgers` 文档提交。按“实际最新 origin/master”建独立 worktree `D:/download/pic-vec/redbase-sms-alipay`，分支 `codex/redbase-sms-alipay`（原名不存在，未覆盖）。
- 基线全绿：check pass；`npm test` 512/512（skip 0）；`test:integration` 197/197；`test:data` 26/26；`typecheck:frontend` pass；`test:frontend` 182/182；`build` pass；`smoke:api` `{"ok":true,...}`；`git diff --check` pass；`verify-change.ps1 -PlanOnly` changedFiles=[]。

### 目标 / 顺序 / 最大风险（≤10 行）

1. 目标：正式可用短信注册/找回密码 + 支付宝电脑网站充值；保持 Cookie Session、用户与积分数据安全。
2. 顺序：任务1 分析闸门（锁依赖、证零丢失）→ 任务2 短信认证（后端+前端）→ 任务3 支付宝与积分（订单+幂等入账+对账）→ 任务4 验收与回滚。
3. 最大风险：并发/乱序支付通知只入账一次；迁移零丢失；重置后旧 session 全部失效；生产 provider 默认 disabled，fake 仅 NODE_ENV=test 显式注入。

### 任务1 分析闸门（2026-08-04）

- 已产出 [docs/sms-alipay-integration-analysis.md](docs/sms-alipay-integration-analysis.md)：真实调用链、SDK/配置契约、API 契约、威胁模型、表结构/索引/状态机、迁移/备份/回滚、文件清单、测试矩阵。
- 锁定依赖并核实官方导出：`alipay-sdk@4.14.0`（`require('alipay-sdk')` 的 `AlipaySdk`）、`@alicloud/dysmsapi20170525@4.6.0`（`require(...)` 的 `.default` + `SendSmsRequest`）。
- 零丢失论证：`isSchemaCurrent()`/`hasCurrentStoreSchema()` 未改；新表走版本化 `schema_migrations`（v1 短信挑战/限流/清空旧明文 verification_codes，v2 payment_orders）；副本迁移测试通过。闸门通过，自动进入实施。

### 任务2+3 实施状态（2026-08-04）

- 后端：短信注册/重置（HMAC+pepper、限流、原子消费、重置删全部 session）、支付宝订单/通知/返回/关闭/本人查询、fake 结算页、对账脚本、配置骨架与示例占位。
- 前端：注册验证码+倒计时、忘记密码重置流、积分充值页（套餐/支付链接/订单状态/测试结算）、导航按套餐可见性显示。
- 已通过：`npm run check`、`npm test` 542/542（skip 0）、`test:integration` 215/215、`test:data` 28/28、`typecheck:frontend`、`test:frontend` 186/186、`build`、`smoke:api`（rechargePlans:0）、reconcile 脚本过期订单标记验证。

### 任务4 验收与回滚（2026-08-04）

- 红→绿：① 破坏 fake 验签（verifyNotify 恒 true）→ `notify rejects bad signature...` 红（bad sign 返回 success）→ 还原绿；② 破坏结算条件（移除 expired→paid）→ `synchronous return never credits and late payment...` 红（expired 未变 paid）→ 还原绿。
- Kimi WebBridge 浏览器验收（隔离 DB + fake provider）：注册验证码可见（160618）、短信重置后新密码登录、充值下单/待支付/支付链接、fake 结算后订单“已支付”、积分 5→15；截图与流程见 `artifacts/verification/kimi-browser-evidence.md`。
- 独立对抗复核：`artifacts/verification/agent-review-evidence.md`（本环境无第二位 reviewer，由执行 agent 按任务书逐条对抗复核并附可复现命令；已如实注明）。
- 全量验证：`verify-change.ps1` R3 全通道通过（static/unit/integration/smoke/data/kimi-browser/agent-review），`.verification/receipt.json` status=pass，fingerprint=`de5ec02784a89d5a45a85bc73e117550dce49222c0f65dfe47bc054df281034a` 与最终 diff 一致；`-CheckReceipt` 通过；`git diff --check` 通过。
- 未提交、未推送、未部署；未改动 `config.local.json`/`.env`/`data/`；生产 provider 默认 disabled，无真实调用。

### 发布审查复审轮（2026-08-04）

- 审查发现 3 个发布阻塞缺陷，全部修复并补红→绿测试：
  - P0：close 改为先调支付宝 `alipay.trade.close`（已支付则结算、网关缺失/失败拒绝本地关闭）；closed 订单收到 TRADE_SUCCESS → `failure` + `closed_provider_paid` 审计，不再 success 吞单。3 测试红→绿。
  - P1：阿里云短信响应按官方小写 `body.code` 解析（原读 `body.Code` 会误判真实成功为失败）。4 测试红→绿。
  - P2：对账先查支付宝再判过期，查询 `created/pending/expired/closed` 未审计订单；过期已付款自动补账、closed 已付款人工审计；fake queryOrder 修正为支付宝下划线契约。3 测试红→绿。
- 新增 v3 迁移（payment_orders.audit_reason/audit_at），迁移零丢失测试断言更新为 `[1,2,3]`。
- 复审轮全量：`npm test` 552/552、`test:integration` 218/218、`test:data` 31/31、`typecheck:frontend`、`test:frontend` 186/186、`build`、`smoke:api`、reconcile sanity 均通过。
- 独立 reviewer 规则：本环境无第二位 reviewer，agent-review 仍由执行 agent 完成（已在证据中如实标注）；receipt 机械通过，待用户/独立 reviewer 复验。

### 发布审查第二轮：SDK 响应契约（2026-08-04）

- 审查发现：官方 `alipay-sdk` 默认 `camelcase=true`，查单返回驼峰字段，对账只读下划线导致真实查询被误判 expired、积分不补；V3 关单成功响应仅 out_trade_no/trade_no，原实现抛“关闭订单失败：unknown”。
- 修复：`RealAlipayProvider.queryOrder` 用 `normalizeAlipayQueryData` 统一转回线协议（snake_case）；`parseCloseTradeResult` 兼容 V3 成功/错误/已支付形状。
- 红→绿：`tests/alipay-sdk-contract.test.js` 5 个测试，修复前 4 红（含用户复现：过期已付款订单误判 expired、积分不变），修复后 5 绿。
- 全量：`npm test` 557/557、`test:integration` 218/218、`test:data` 31/31、`typecheck:frontend`、`test:frontend` 186/186、`build`、`smoke:api` 全部通过。

### 发布审查第三轮：P5 验证码账号枚举旁路 + P6 关闭支付后入口仍显示（2026-08-04）

- 目标：只修复 P5（通用 send-code 封堵 reset_password 枚举旁路）与 P6（关闭新支付后套餐接口/前端充值入口彻底隐藏），不做架构重构。
- 开始前：确认 worktree `D:/download/pic-vec/redbase-sms-alipay`、分支 `codex/redbase-sms-alipay`，现有 diff 全部保留；CodeGraph 目录存在但无索引（工具明确提示不要自行 init），已跳过并记录。
- 现有缺陷确认：
  - P5：`/api/auth/send-code` 的 `VERIFICATION_PURPOSES` 含 `reset_password`，已注册号码可触发真实发码/429，未注册号码统一 200，形成账号枚举旁路。
  - P6：`GET /api/billing/recharge-plans` 无条件返回配置套餐，`alipay.enabled=false` 时前端仍展示“积分充值”，下单才 503。
- 本轮计划：先在 `tests/api/sms-auth-routes.test.js`、`tests/api/payment-routes.test.js` 补红测试并记录失败；再改 `auth-routes.js`、`payment-routes.js` 转绿；前端补充充值导航显示/隐藏覆盖；最后跑全量确定性验证与 PlanOnly，receipt 留待外部独立 reviewer。

### 发布审查第三轮结果（2026-08-04）

- P5 修复：`/api/auth/send-code` 只允许 `register`；`reset_password` 在查询用户/发短信/写码前统一 400 + 固定消息拒绝，不再暴露 200/429 差异；专用 `/api/auth/reset-password/send-code` 与手机号/IP/全局限流保持不变。
- P6 修复：`GET /api/billing/recharge-plans` 在 `alipay.enabled !== true` 或网关不可用时返回 `{plans: [], fakeSettle: false}`；启用且配置有效时维持原返回；通知/查单/对账/补账路径未改动。
- 红→绿：先补 4 个 P5 + 3 个 P6 回归测试，红阶段 5 失败（存在/不存在号响应不一致、200/429 差异、关闭态仍返回套餐等，完整输出见 `outputs/red-green-p5-p6.txt`）；修复后目标测试 28/28 全绿。
- 前端覆盖：`workspace-legacy-visual.test.ts` 新增 2 个导航显示/隐藏测试（plans 空隐藏、非空显示）。
- 浏览器验收（隔离 DB + fake）：关闭态导航无“积分充值”，启用态显示“充 积分充值”，截图 `artifacts/verification/kimi-p6-billing-off.png` / `kimi-p6-billing-on.png`。
- 确定性验证全部通过：`npm test` 564/564、`test:integration` 225/225、`test:data` 31/31、`typecheck:frontend`、`test:frontend` 188/188、`build`、`smoke:api`、`git diff --check`、`verify-change.ps1 -PlanOnly`（R3）。
- 独立审查状态：本环境无独立 reviewer；agent-review 证据已明确标注“等待独立 reviewer”。按目标，本轮停在所有确定性通道 + PlanOnly，`.verification/receipt.json` 保持上一轮旧指纹，未手改、未伪造 pass，待外部复审后重新生成。

### 外部独立复审（2026-08-04）

- 独立 reviewer 已重新阅读仓库策略、当前 diff、P5/P6 路由实现与回归测试；执行者未参与本轮批准。
- 对抗性复现通过：P5 对已存在/不存在手机号及连续请求均固定拒绝，且不调用 SMS provider、不写验证码；P6 在支付关闭/网关不可用时返回空套餐，启用时正常返回，存量 notify 测试继续通过。
- 独立运行：P5/P6 后端 28/28、前端导航 9/9、`npm test` 564/564、integration 225/225、data 31/31；两张 Kimi 关闭/启用截图已人工核对。
- 独立证据写入 `artifacts/verification/independent-review-evidence.md`；随后按最终指纹刷新 evidence，并执行完整 R3 verifier 与 `-CheckReceipt`。
