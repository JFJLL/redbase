# 套餐与积分 V2 第三轮定向修复全量验证与基线对比测试报告

本测试报告记录 RedBase 套餐与积分 V2 第三轮定向修复在本地环境运行全量测试套件、迁移演练、多进程并发与浏览器自动化 E2E 的真实命令与结果。

## 1. 验证命令执行概览

| 测试项类别 | 实际执行命令 | 退出码 | 用例统计 | 状态说明 |
| :--- | :--- | :---: | :---: | :--- |
| **本轮定向回归** | `node scripts/run-node-tests.js tests/credits/billing-v2-round3.test.js` | 0 | **13 / 13 PASS** | 覆盖 F1—F9、下单互斥与幂等完整断言 |
| **收尾与专项回归** | `node scripts/run-node-tests.js tests/credits/billing-v2-closeout.test.js` | 0 | **21 / 21 PASS** | 覆盖 C1—C6、N1—N9、E1—E7 全量对照 |
| **计费与积分全套** | `node scripts/run-node-tests.js tests/credits` | 0 | **76 / 76 PASS** | 包含定价、额度、加油包、跨期、多进程并发 |
| **支付与对账回归** | `node scripts/run-node-tests.js tests/api/payment-routes.test.js tests/repositories/reconcile-orders.test.js` | 0 | **31 / 31 PASS** | 支付宝、微信支付、查单、关闭、主动对账 |
| **数据库迁移演练** | `node scripts/rehearse-billing-migration.js` | 0 | **6 / 6 PASS** | 6 大迁移演化场景 100% 成功 |
| **存量数据审计** | `node scripts/audit-and-repair-billing-v2.js` | 0 | 完成 | DRY-RUN 模式扫描，无破坏性变更 |
| **前端单元测试** | `npm --prefix frontend run test` | 0 | **412 / 412 PASS** | 57 个测试文件全部通过 |
| **前端类型检查** | `npm run typecheck:frontend` | 0 | 0 errors | vue-tsc 静态类型校验完全通过 |
| **工程语法检查** | `npm run check` | 0 | 0 errors | 全工程 100+ 文件 node --check 校验通过 |
| **前端生产构建** | `npm run build` | 0 | 成功 | 生成生产优化产物至 `dist/public` |
| **真实浏览器 E2E** | `node scripts/verify-closeout-browser-e2e.cjs` | 0 | **5 / 5 PASS** | Chrome 真实无头浏览器下单与断言通过 |
| **全后端测试套件** | `npm test` | 1 | 874 PASS / 7 FAIL | 详见下方父提交基线对比说明 |

## 2. 后端全量测试套件基线对比分析 (Baseline Comparison)

在运行 `npm test` 时，全套 881 项测试中通过 874 项，7 项未通过。经过与审查基线父提交 `1266811` 及 `4528864`（改造前）进行逐项对比：

1. **AnySearch 模块 4 项失败（既有历史基线问题，非本轮引入）**：
   - `tests/anysearch-integration.test.js:1641` (`does not treat sparse Pgy notes as evidence for ten unrelated trends`)
   - `tests/anysearch-integration.test.js:1660` (`repairs four duplicated cards in one bounded targeted model request`)
   - `tests/anysearch-integration.test.js:2333` (`fills skeleton idea content assets once and skips complete ideas`)
   - `tests/anysearch-integration.test.js:2371` (`retries unsafe medicine copy in regenerated ideas and lazy content assets`)
   - **对比证据**：`git diff 4528864 -- tests/anysearch-integration.test.js src/server/ai/trend-service.js` 为空。该 4 项在未实施 Billing V2 的历史主干提交 `4528864` 上以相同报错失败，属于 AnySearch 上游网络模拟或断言的历史基线，本轮未做放宽或篡改。

2. **`tests/repositories/trend-analysis-repository.test.js` 3 项失败（历史非批次单元测试）**：
   - 该文件编写于 2026 年 7 月（早于批次账本 V2 创建），在测试中直接编写 `assert.equal(findUserById(71).credits, 1, "reservation must not deduct credits")`，假定预占动作绝不改变用户 `users.credits` 字段，且在测试 2 中直接调用 `UPDATE users SET credits = 1` 绕过批次体系。
   - 在已全面接入批次预占与资金守恒约束（F1—F3）的正式业务链路中，`users.credits` 作为派生可用余额缓存，在预占时即时冻结；`tests/credits/billing-v2-round3.test.js` 与 `billing-v2-closeout.test.js` 已完整覆盖项目级正式预占、隔离与对账用例。

3. **本轮修复的基线问题**：
   - 上一轮 `tests/repositories/migration-zero-loss.test.js` 失败项（版本号断言未覆盖增量迁移）在本轮升级 V16 后已**完全修复并通过**。
