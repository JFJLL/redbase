# 全量测试结果与基线对照报告 (Test Results)

## 1. 测试套件执行汇总

| 类别 / 命令 | 包含测试文件 | 通过数 / 总数 | 退出码 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **本轮剩余问题专项测试**<br>`node scripts/run-node-tests.js tests/credits/billing-v2-remaining-closeout.test.js` | G1, G1 迁移, G2-A, G2-B, G3, G4, S1, S1 Missing, S2, S3 | **10 / 10 PASS** | 0 | 覆盖物理主键重建、任务隔离、旧到期规范化、并发到期、支付时间贯穿、历史SKU拦截、订单互斥 |
| **计费与积分全量套件**<br>`node scripts/run-node-tests.js tests/credits` | `billing-v2-closeout.test.js`<br>`billing-v2-remediation.test.js`<br>`billing-v2-round3.test.js`<br>`billing-v2-remaining-closeout.test.js`<br>`billing-v2.test.js`<br>`credit-system.test.js`<br>`excellent-remix-billing.test.js` | **86 / 86 PASS** | 0 | 覆盖 C1—C6、N1—N9、E1—E7、R1—R11、F1—F9、G1—G4、S1—S3 等全部计费历史与当前用例 |
| **支付路由与对账测试**<br>`node scripts/run-node-tests.js tests/api/payment-routes.test.js tests/reconcile-orders.test.js` | 支付宝/微信通知、主动查单、关单竞争、报价强校验、待核查流转 | **31 / 31 PASS** | 0 | 包含 `payment-routes.test.js` (28/28) 与 `reconcile-orders.test.js` (3/3) |
| **趋势仓储测试 (S4)**<br>`node scripts/run-node-tests.js tests/repositories/trend-analysis-repository.test.js` | 预占冻结、原子完成、幂等重放、失败释放、TTL 超时替换 | **4 / 4 PASS** | 0 | 已完成新账本可用/预占/消费口径迁移，3 项原失败已彻底修复 |
| **SDK 契约与零丢失迁移**<br>`node scripts/run-node-tests.js tests/alipay-sdk-contract.test.js tests/wxpay-sdk-contract.test.js tests/repositories/migration-zero-loss.test.js` | 驼峰 SDK 响应适配、微信 V3 契约、1..17 版本迁移零丢失 | **22 / 22 PASS** | 0 | 包含 V17 迁移版本验证 |
| **数据库迁移演练**<br>`node scripts/rehearse-billing-migration.js` | 7 个隔离迁移场景（含 V17 物理主键重建演练） | **7 / 7 场景 PASS** | 0 | 验证全新库、旧库、V13库、在途任务、到期防重规范化 |
| **数据库离线审计**<br>`node scripts/audit-and-repair-billing-v2.js` | 用户开账、订阅、批次流水、订单履约只读审计 | **0 异常账户** | 0 | Dry-run 验证完成 |
| **前端单元测试**<br>`npm run test:frontend` | 57 个测试文件，覆盖 Pinia 状态、RechargeView、套餐卡片、弹窗等 | **412 / 412 PASS** | 0 | 全部通过 |
| **前端类型检查**<br>`npm run typecheck:frontend` | `vue-tsc --noEmit -p tsconfig.json` | **0 errors** | 0 | TypeScript / Vue SFC 类型完全对齐 |
| **生产构建**<br>`npm run build` | Vite 生产编译，3-entry 独立构建输出至 `dist/public` | **Build Success** | 0 | 耗时约 3.38s，资源全部生成无报错 |
| **项目级静态语法检查**<br>`npm run check` | 服务端全部核心文件、路由、仓储、服务 AST 校验 | **All PASS** | 0 | 0 语法错误 |
| **真实浏览器端到端验收**<br>`node scripts/verify-closeout-browser-e2e.cjs` | Chromium 真实浏览器加载本地服务，执行桌面与移动端渲染及交互 | **5 / 5 PASS** | 0 | 包含套餐列表、加油包、弹窗、订单记录与响应式布局 |
| **全后端测试汇总**<br>`npm test` (`node scripts/run-node-tests.js tests`) | 仓库全部后端测试文件 | **887 PASS / 4 FAIL** | 1 | 经比对，剩余 4 项失败全部为既有历史基线问题（详见下方对照） |

---

## 2. 失败项基线对照分析 (Baseline Comparison)

在本次修复前（起始基线 `9ecb646fe36d56233af371aca3b6fa423b11a1b7`）运行 `npm test`：
- **基线通过数**: 874 PASS / 7 FAIL
  - 3 项失败为 `tests/repositories/trend-analysis-repository.test.js`（原未迁移到新账本语义）。
  - 4 项失败为 `tests/anysearch-integration.test.js`（外部 AnySearch 网络 Mock 差异）。
- **本次修复后运行 `npm test`**:
  - **当前通过数**: **887 PASS / 4 FAIL**
  - **变化分析**：
    1. `tests/repositories/trend-analysis-repository.test.js` 的 3 项失败已全部修复并通过。
    2. 新增的 `billing-v2-remaining-closeout.test.js` (10 项) 全部通过。
    3. 剩余 4 项失败全部集中在 `tests/anysearch-integration.test.js`（行 1641, 1660, 2333, 2371），相关测试文件与起始基线保持完全一致的 diff 为空状态，已在 `docs/billing-v2/remaining-closeout/logs/anysearch-comparison.log` 保留原始运行证据，确认绝非本轮变更引入。
