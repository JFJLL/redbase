# RedBase 套餐与积分 V2：全量验收与复核矩阵

> **修订说明**：本矩阵包含上一版本（审查提交 `79220ac`）的遗留问题复核及本轮定向整改后的全量验收结论。历史审查报告中指出的 11 项约束缺陷（R1–R11）已在本轮全部根治并完成真实项目级测试覆盖，详细根因分析见 [remediation/root-cause-matrix.md](./remediation/root-cause-matrix.md)。

---

## 1. 核心业务与整改验收矩阵

| 序号 | 验收项 | 验收标准与预期结果 | 实际执行验证方式 | 验证结果 | 对应证据与文件 |
| --- | --- | --- | --- | :---: | --- |
| **A1** | **工作台导航入口** | 左侧工作台导航不增加“套餐与积分”或充值菜单；保留原生导航。 | 检查 `WorkspaceShell.vue` 侧栏导航项并进行真实浏览器快照核验。 | **通过** | `docs/billing-v2/remediation/ui-verification/01-overview-monthly-desktop.png` |
| **A2** | **个人中心入口** | 点击头像进入个人中心，展示当前套餐、到期日、可用积分；点击“套餐与积分”或“查看订单”正确直达对应功能。 | 运行前端单元测试及真实浏览器端点击交互。 | **通过** | `docs/billing-v2/remediation/ui-verification/09-workspace-account-modal-desktop.png` |
| **A3** | **无货币折算展示** | 正式界面及弹窗删除“每积分 ¥X”、“折合月价”、“同预算对比”，只展示真实应付总价与到期日。 | 对照 V2 交互页面 DOM 与样式代码检查。 | **通过** | `docs/billing-v2/remediation/ui-verification/01-overview-monthly-desktop.png` |
| **A4** | **无演示设施污染** | 正式构建与页面不包含演示身份切换、重置演示、模拟支付等测试后门。 | 检查构建产物与生产页面，测试 fixture 与生产代码物理隔离。 | **通过** | `frontend/src/features/billing/views/RechargeView.vue` |
| **A5** | **多端响应式适配** | 桌面端 1440/1280 宽与手机端 390 宽下无横向溢出，卡片与弹窗排版自然。 | Playwright 真实浏览器截图对照。 | **通过** | `docs/billing-v2/remediation/ui-verification/10-overview-mobile.png` |
| **B1** | **套餐目录与定价** | 轻量版 (¥299/月, ¥2,990/年, 100分/月)、专业版 (¥999/月, ¥9,990/年, 400分/月)、业务版 (¥2,999/月, ¥29,990/年, 1,500分/月)；加油包 25/80/300 永久积分 (¥99/¥299/¥999)。 | 服务端 `catalog.js` 配置核对及组件渲染测试。 | **通过** | `src/server/billing/catalog.js` |
| **B2** | **V2 标准升级算例 (C1)** | 专业版月付 (2026.09.23-10.23) 于 10.16 升业务版：补款精确得到 ¥466.67，补发 257 积分；本期可用 120→377，总可用 677；原到期日不变。 | 运行 `tests/credits/billing-v2-remediation.test.js` (C1) 自动化用例验证。 | **通过** | `tests/credits/billing-v2-remediation.test.js` (C1) |
| **B3** | **连续升级精确累加 (R6)** | 31 天周期剩 3 天连续升级，按累计精确增量取整，补发 30+106=136 积分，不按每次独立 ceil 导致多发 1 分。 | 运行 `tests/credits/billing-v2-remediation.test.js` (R6) 用例验证。 | **通过** | `tests/credits/billing-v2-remediation.test.js` (R6) |
| **B4** | **待生效安排与排他 (R4)** | 续费/降档/周期切换均在当前已购服务结束后生效；账户最多 1 个待生效安排，重复购买被拦截，加油包不受排他限制。数据库唯一排他保障。 | 运行 `tests/credits/billing-v2-remediation.test.js` (R4, R9) 测试。 | **通过** | `docs/billing-v2/remediation/ui-verification/07-scheduled-modal-desktop.png` |
| **C1** | **日历月与闰年计算 (C2, R5)** | 月末锚点保持：1月31日购月付，2月截断至28日（闰年29日），3月恢复31日，不累进漂移。续费激活保留原31日锚点。 | 运行 `tests/credits/billing-v2-remediation.test.js` (C2, R5) 覆盖平年、闰年与续期跨月。 | **通过** | `src/server/billing/period-utils.js` |
| **C2** | **积分批次 FIFO 顺序** | 优先扣减最早到期的周期/补发批次，最后扣减永久积分；足额任务支持跨批次结算。 | 运行 `tests/credits/billing-v2.test.js` FIFO 批次扣减测试。 | **通过** | `src/server/billing/credit-ledger.js` |
| **C3** | **跨到期与任务恢复** | 预占中任务到期不额外扣分，失败释放已到期部分不返现为永久积分；重启恢复未完成任务预占。 | 运行 `tests/credits/billing-v2-remediation.test.js` 跨期成功与失败用例。 | **通过** | `tests/credits/billing-v2-remediation.test.js` |
| **C4** | **扣分链路统一收口 (R1, R2)** | 消除全仓绕过批次的直接 `UPDATE users SET credits` 旁路；趋势分析、图片生成、优秀内容、视频脚本与项目全部统一走账本。 | 运行 `tests/credits/billing-v2-remediation.test.js` (R1, R2) 及全仓余额链路审计。 | **通过** | `docs/billing-v2/remediation/balance-path-audit.md` |
| **D1** | **服务端不可变报价 (R3, R7)** | 报价绑定订阅版本与成交快照；目录改价或旧报价重复使用时正确失效/拦截；下单严格校验 quoteId。 | 运行 `tests/credits/billing-v2-remediation.test.js` (R3, R7)。 | **通过** | `src/server/billing/quote-service.js` |
| **D2** | **支付与履约状态解耦 (R8, R9)** | 分离支付状态与履约状态；年付分期与到期写入可见流水；激活排期时同步订单 fulfilled。前端准确展示履约状态，不虚假报喜。 | 运行 `tests/credits/billing-v2-remediation.test.js` (R8, R9) 及截图核对。 | **通过** | `docs/billing-v2/remediation/ui-verification/05-orders-desktop.png` |
| **D3** | **旧数据无损迁移与防丢失 (R10)** | 首笔业务写入前原子结转旧余额，旧永久余额 100% 保留永久有效；演练前后总额 100% 对齐，重复执行 0 变动。 | 执行 `scripts/rehearse-billing-migration.js` 演练脚本。 | **通过** | `scripts/rehearse-billing-migration.js` |
| **D4** | **年付当期统计范围 (R11)** | 年付当前权益周期“本期已使用”仅统计本月账期，不把过去月份的使用量混淆为当期已用。 | 运行 `tests/credits/billing-v2-remediation.test.js` (R11)。 | **通过** | `tests/credits/billing-v2-remediation.test.js` (R11) |

---

## 2. 结论

整改后的代码已在本地全面建立项目级回归保护，消除全部审查缺陷，前后端测试全量通过，满足正式交付标准。