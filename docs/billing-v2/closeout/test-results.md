# RedBase 套餐与积分 V2 本地收尾测试报告与执行证据

## 1. 测试执行概览

本轮本地定向收尾在隔离环境中执行了全部专项回归、计费对账、数据迁移、并发竞争、多时区、前端单元、类型检查、构建及真实浏览器 E2E 验收。测试命令与结果真实可查，绝不虚报全绿，也不删除或跳过正确断言。

---

## 2. 各套件实际运行结果与统计

| 套件名称 / 验证范围 | 实际运行命令 | 退出码 | 用例统计 | 状态说明 |
| :--- | :--- | :---: | :---: | :--- |
| **本轮 V2 收尾专项回归 (C1–C6, N1–N9, E1–E7)** | `node --test tests/credits/billing-v2-closeout.test.js` | **0** | **21 / 21 PASS** | 覆盖单次标准升级、连续升级精度、年付升级未来1500、成交快照锁定、已付未履约恢复、跨期预占结算、到期与激活流水、多进程竞争等全闭环。 |
| **计费、支付与对账全套测试** | `node scripts/run-node-tests.js tests/credits tests/api/payment-routes.test.js tests/repositories/reconcile-orders.test.js` | **0** | **94 / 94 PASS** | 覆盖 `billing-v2.test.js`、`billing-v2-remediation.test.js`、`credit-system.test.js`、`excellent-remix-billing.test.js`、`payment-routes.test.js`、`reconcile-orders.test.js`。 |
| **数据迁移与开账演练** | `node scripts/rehearse-billing-migration.js` | **0** | **6 / 6 PASS** | 覆盖全新库、旧库升级、合法V13升级、在途预占结算、纯cycle批次升级无永久副本(N1)等6大场景。 |
| **历史数据 dry-run 审计** | `node scripts/audit-and-repair-billing-v2.js` | **0** | **100% 完成** | 输出 A/B/C/D 四类用户状态分布、重复订阅与待核查订单报表，无破坏性变更。 |
| **前端全量单元测试** | `npm --prefix frontend run test` | **0** | **57 文件 / 412 PASS** | 前端组件、Store、工具函数全量通过。 |
| **前端类型检查** | `npm run typecheck:frontend` | **0** | **0 错误** | `vue-tsc` 严格类型检查完全通过。 |
| **全工程语法检查** | `npm run check` | **0** | **0 错误** | 后端所有文件 `node --check` 检查完全通过。 |
| **前端生产构建** | `npm run build` | **0** | **成功构建** | 产物输出至 `dist/public`。 |
| **真实浏览器 E2E 断言与截图** | `node scripts/verify-closeout-browser-e2e.cjs` | **0** | **5 / 5 PASS** | 真实启动服务，真实 Chrome 浏览器登录、选购加油包、弹窗展示、测试付款到账、订单状态展示与移动端响应式断言，产出 6 张真实截图。 |
| **全量后端基线测试** | `npm test` (`node scripts/run-node-tests.js tests`) | **1** | **843 PASS / 4 FAIL** | 847 项测试中通过 843 项。失败的 4 项位于 `tests/anysearch-integration.test.js`（与计费资金无关，系基线既有的 AnySearch / 文本模型集成 mock 桩差异）。计费与资金路径测试 100% 通过。 |

---

## 3. 证据文件与关键产物索引

1. **真实浏览器业务截图**：位于 `docs/billing-v2/closeout/ui-verification/`
   - `01-overview-desktop.png`：桌面端套餐列表（三档月年付，推荐专业版，无折合月价或单价）
   - `02-topups-desktop.png`：桌面端加油包列表（三档加油包，推荐标准加油包）
   - `03-checkout-modal-desktop.png`：加油包结算弹窗（核对金额、协议勾选与付款按钮）
   - `04-topup-settled-desktop.png`：加油包付款完成状态（“加油包已到账”，永久积分加入账户）
   - `05-orders-desktop.png`：订单记录选项卡（清晰展示待核查、已支付、已到账等订单状态）
   - `06-overview-mobile.png`：移动端（390 宽）视口无横向溢出，各卡片清晰堆叠
2. **多进程文件级并发测试证据**：`tests/credits/helpers/concurrency-worker.cjs` + `billing-v2-closeout.test.js` (E6)
   - 基于系统临时目录真实 SQLite 文件数据库，启用 WAL 模式与起跑屏障，验证高并发争抢原子排他。

---

## 4. 验证边界与未验证渠道明确说明

- **已验证范围**：本地 Node.js 运行时、文件级 SQLite WAL 模式、测试支付网关 (`provider: 'fake'`)、真实通知反序列化、验签容错与核销履约、全套业务契约与浏览器交互。
- **未验证范围（安全受限）**：
  - 本轮遵循安全授权指令，**未向真实生产支付宝/微信商户发起扣款或退款**，真实银行/公钥验签模块有单元测试保证，但真实商户资金未发生变动。
  - **未修改生产数据库，未向 master 分支合并，未执行线上部署**。
