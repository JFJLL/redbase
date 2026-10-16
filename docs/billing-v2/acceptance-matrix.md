# RedBase 套餐与积分 V2 逐项验收矩阵

| 序号 | 验收项 | 验收标准与预期结果 | 实际执行验证方式 | 验证结果 | 对应证据与文件 |
| --- | --- | --- | --- | :---: | --- |
| **A1** | **工作台导航入口** | 左侧工作台导航不增加“套餐与积分”或充值菜单；保留原生7项导航。 | 检查 `WorkspaceShell.vue` 侧栏导航项并进行浏览器快照核验。 | **通过** | `docs/billing-v2/ui-verification/01-overview-desktop.png` |
| **A2** | **个人中心入口** | 点击头像进入个人中心，展示当前套餐、到期日、可用积分；点击“套餐与积分”或“查看订单”正确直达对应功能。 | 运行 `src/app/__tests__/workspace-legacy-visual.test.ts` 及浏览器端点击操作。 | **通过** | `docs/billing-v2/ui-verification/04-account-modal-desktop.png` |
| **A3** | **无货币折算展示** | 正式界面及弹窗删除“每积分 ¥X”、“折合月价”、“同预算对比”，只展示真实应付总价与到期日。 | 对照 V2 交互页面 DOM 与样式代码检查。 | **通过** | `docs/billing-v2/ui-verification/01-overview-desktop.png` |
| **A4** | **无演示设施污染** | 正式构建与页面不包含演示身份切换、重置演示、模拟支付等测试后门。 | 检查构建产物与生产页面，测试 fixture 与生产代码物理隔离。 | **通过** | `frontend/src/features/billing/views/RechargeView.vue` |
| **A5** | **多端响应式适配** | 桌面端 1440 宽与手机端 390 宽下无横向溢出，卡片与弹窗排版自然。 | Playwright 真实浏览器截图对照。 | **通过** | `docs/billing-v2/ui-verification/05-overview-mobile.png` |
| **B1** | **套餐目录与定价** | 轻量版 (¥299/月, ¥2,990/年, 100分/月)、专业版 (¥999/月, ¥9,990/年, 400分/月)、业务版 (¥2,999/月, ¥29,990/年, 1,500分/月)；加油包 25/80/300 永久积分 (¥99/¥299/¥999)。 | 服务端 `catalog.js` 配置核对及组件渲染测试。 | **通过** | `src/server/billing/catalog.js` |
| **B2** | **V2 标准升级算例** | 专业版月付 (2026.09.23-10.23) 于 10.16 升业务版：补款精确得到 ¥466.67，补发 257 积分；本期可用 120→377，总可用 677；原到期日不变。 | 运行 `tests/credits/billing-v2.test.js` 自动化用例验证。 | **通过** | `tests/credits/billing-v2.test.js` |
| **B3** | **年付升级与发券** | 金额按剩余年期服务时长计算，本期补发按月度时长，后续未发月份按新档位额度；共 12 期无第 13 期。 | 运行 `tests/credits/billing-v2.test.js` 针对年付升级与分期用例。 | **通过** | `tests/credits/billing-v2.test.js` |
| **B4** | **待生效安排与排他** | 续费/降档/周期切换均在当前已购服务结束后生效；账户最多 1 个待生效安排，重复购买被拦截，加油包不受排他限制。 | 运行待生效唯一约束与报价测试。 | **通过** | `tests/credits/billing-v2.test.js` |
| **C1** | **日历月与闰年计算** | 月末锚点保持：1月31日购月付，2月截断至28日（闰年29日），3月恢复31日，不累进漂移。 | 运行 `period-utils.test.js` 覆盖 2026 平年与 2028 闰年边界。 | **通过** | `src/server/billing/period-utils.js` |
| **C2** | **积分批次 FIFO 顺序** | 优先扣减最早到期的周期/补发批次，最后扣减永久积分；足额任务支持跨批次结算。 | 运行 `tests/credits/billing-v2.test.js` FIFO 批次扣减测试。 | **通过** | `src/server/billing/credit-ledger.js` |
| **C3** | **跨到期与任务恢复** | 预占中任务到期不额外扣分，失败释放已到期部分不返现为永久积分；重启恢复未完成任务预占。 | 运行 `tests/credits/credit-system.test.js` 跨到期与退款用例。 | **通过** | `tests/credits/credit-system.test.js` |
| **C4** | **扣分链路统一收口** | 现有所有生成任务、趋势分析、图片生成、视频脚本扣减统一接入新账本，更新 `users.credits` 缓存。 | 全仓搜索余额写入点，消除绕过批次的直接 `UPDATE users SET credits` 旁路。 | **通过** | `src/server/db/repositories/admin-repository.js` |
| **D1** | **服务端不可变报价** | 前端不传价格和积分；服务端生成不可变报价并绑定时效；超时或被篡改时下单拒绝。 | 检查 `quote-service.js` 签名校验及订单创建逻辑。 | **通过** | `src/server/billing/quote-service.js` |
| **D2** | **支付与履约状态解耦** | 分离支付状态 (`created`/`pending`/`paid`/`closed`) 与履约状态 (`unfulfilled`/`fulfilled`/`scheduled`/`audit_required`)；防重防篡改。 | 运行 `tests/api/payment-routes.test.js` 并发与防重测试。 | **通过** | `tests/api/payment-routes.test.js` |
| **D3** | **旧数据无损迁移** | 切换前旧余额入账“历史保留积分”批次，永久保留有效性；演练前后总额 100% 对齐，重复执行 0 变动。 | 执行 `scripts/rehearse-billing-migration.js` 演练脚本。 | **通过** | `scripts/rehearse-billing-migration.js` |
| **D4** | **旧订单跨版本履约** | 切换前创建但切换后付款的旧订单按原有永久规则履约，不追加到期日且仅入账一次。 | 演练脚本包含跨版本订单履约模拟。 | **通过** | `scripts/rehearse-billing-migration.js` |
