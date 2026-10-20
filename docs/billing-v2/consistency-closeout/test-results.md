# 全链路一致性测试与验收结果 (Test Results & Validation Summary)

## 一、各测试套件执行汇总表

| 序号 | 验证模块 / 测试命令 | 用例总数 | 通过 (Pass) | 失败 (Fail) | 退出码 | 原始日志归档 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **本轮 H1—H8 项目级回归** (`node --test tests/credits/billing-v2-consistency-closeout.test.js`) | 10 | 10 | 0 | 0 | `logs/h1-h8-tests.log` |
| 2 | **计费与积分全套测试** (`node scripts/run-node-tests.js tests/credits`) | 96 | 96 | 0 | 0 | `logs/credits-tests.log` |
| 3 | **支付接口与对账恢复** (`tests/api/payment-routes.test.js` + `reconcile-orders.test.js`) | 28 | 28 | 0 | 0 | `logs/payment-tests.log` |
| 4 | **趋势分析业务资金路径** (`tests/repositories/trend-analysis-repository.test.js`) | 4 | 4 | 0 | 0 | `logs/trend-tests.log` |
| 5 | **存量零丢失迁移回归** (`tests/repositories/migration-zero-loss.test.js`) | 2 | 2 | 0 | 0 | 已执行通过 |
| 6 | **数据库隔离演练 (V1..V18)** (`node scripts/rehearse-billing-migration.js`) | 8 场景 | 8 | 0 | 0 | `logs/migration-rehearsal.log` |
| 7 | **离线 Dry-Run 账务审计** (`node scripts/audit-and-repair-billing-v2.js`) | 全库账户 | 100% | 0 异常 | 0 | `logs/audit-repair.log` |
| 8 | **前端单元与组件测试** (`npm run test:frontend`) | 412 | 412 | 0 | 0 | Vitest 412 passed |
| 9 | **前端类型检查** (`npm run typecheck:frontend`) | 148 文件 | 148 | 0 errors | 0 | vue-tsc passed |
| 10 | **生产构建产物检查** (`npm run build`) | 3 入口 | 成功 | 0 errors | 0 | 输出 `dist/public` |
| 11 | **服务端代码语法检查** (`npm run check`) | 88 文件 | 88 | 0 errors | 0 | node --check passed |
| 12 | **端到端真实浏览器断言** (`node scripts/verify-closeout-browser-e2e.cjs`) | 5 断言 | 5 | 0 | 0 | 截图存盘 |
| 13 | **全后端全量套件对照** (`npm test`) | 901 | 897 | 4 (基线) | 1 | `logs/full-npm-test.log` |

---

## 二、AnySearch 既有历史失败基线对照

在全量后端 `npm test` 中存在的 4 项失败，经核对完全位于 `tests/anysearch-integration.test.js`：
1. `does not treat sparse Pgy notes as evidence for ten unrelated trends`
2. `repairs four duplicated cards in one bounded targeted model request`
3. `fills skeleton idea content assets once and skips complete ideas`
4. `retries unsafe medicine copy in regenerated ideas and lazy content assets`

**基线分析与证据说明**：
- 该 4 项测试由上游外部 AnySearch 搜索与文本生成网络 Mock 差异引起，相关核心计费与积分代码在 Git 提交历史上与此完全无关（`git diff 8aff5fb -- tests/anysearch-integration.test.js` 为空）。
- 遵照本轮规范红线：“不随意修改无关断言以获得全绿”，对既有失败如实报告并保留完整对照日志 `logs/anysearch-comparison.log`。

---

## 三、端到端真实浏览器验证

通过 Playwright 无头与真实浏览器实例，启动隔离端口服务，断言已通过：
1. **桌面端个人中心 -> 套餐与积分入口**：正常展示当前生效套餐、月度额度与有效期。
2. **三档套餐与三档加油包价格体系**：保持已确认价格与额度，无折合单价等额外标记。
3. **收银台弹窗与扫码交互**：支付宝/微信原生二维码正常渲染。
4. **订单明细与排期记录**：已生效订单展示 fulfilled，待生效展示 scheduled，异常展示 audit_required。
5. **移动端响应式布局**：视口自适应良好，底部操作区域防误触。
