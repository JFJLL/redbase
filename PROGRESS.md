# PROGRESS

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
