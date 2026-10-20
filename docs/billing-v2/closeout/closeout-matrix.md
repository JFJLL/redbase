# RedBase 套餐与积分 V2 本地收尾验收矩阵 (C1–C6, N1–N9, E1–E7)

## 1. 验收基准与审查对照

本轮收尾以审查提交 `126681169282b417e832442bac6ba9ccb6e75bc3` 为基线，针对第二轮审查指出的 9 项阻断缺陷（N1–N9）完成全链路闭环整改，并完整保留并增强已通过的 6 项基准算例（C1–C6）及扩展可靠性矩阵（E1–E7）。所有关键断言全部以项目正式代码、正式 HTTP 路由、真实数据库订单模型与测试支付回调串联执行。

---

## 2. 核心验收矩阵表

| 编号 | 检查类别 | 核心断言 / 业务场景 | 审查缺陷根因定位 | 修复文件与核心符号 | 验证测试与结果 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **C1** | 基准升级算例 | 466.67元补差价，补发257分；本期120→377分；永久300分不变；总可用677分；原到期日与已用记录不变。 | 原本已通过，需防止重构破坏。 | `quote-service.js` / `subscription-service.js` | `billing-v2-closeout.test.js` (C1) - **PASS** |
| **C2** | 普通任务消费 | 任务消费后刷新钱包，扣减持久化且不被只读重刷复原（100→99）。 | 原本已通过，需确认批次扣费正常。 | `trend-analysis-repository.js` | `billing-v2-closeout.test.js` (C2) - **PASS** |
| **C3** | 过期缓存防扣 | 遇到过期批次缓存拒绝扣费 (`spent: false`)，禁止成功扣费或产生脏数据。 | 原本已通过，无空 catch。 | `credit-ledger.js` (`spendCreditsFromLots`) | `billing-v2-closeout.test.js` (C3) - **PASS** |
| **C4** | 月末锚点衔接 | 1/31开通月付续费，2/28激活时继承锚点31，新周期积分精准到3/31到期，3/29合法可用。 | 原本已通过，排期字段持久化。 | `subscription-service.js` / `period-utils.js` | `billing-v2-closeout.test.js` (C4) - **PASS** |
| **C5** | 历史余额首充 | 未开账历史5分余额直接购买25分加油包，开账一次，合并总额严格为30分。 | 原本已通过，前置安全开账。 | `credit-ledger.js` (`migrateLegacyUserCredits`) | `billing-v2-closeout.test.js` (C5) - **PASS** |
| **C6** | 年付当期统计 | 年付第一期已用280分，进入第二期使用10分，当期使用量仅计10分，不把全年误计为当期。 | 原本已通过，限定周期范围。 | `subscription-service.js` (`getUserBillingOverview`) | `billing-v2-closeout.test.js` (C6) - **PASS** |
| **N1** | 迁移安全防重 | 合法 V13 库仅有 cycle 400 批次且无 legacy 批次：升级后仍为 total 400，绝不新增永久400，到期后安全归0。 | `migrateLegacyUserCredits` 仅凭无 legacy 批次误将批次缓存当历史余额重复结转；V14 迁移盲目用 `MAX(id)` 静默废弃 active 订阅。 | `credit-ledger.js` (`migrateLegacyUserCredits`)<br>`migrations.js` (V14 修复 & V15 增量) | `billing-v2-closeout.test.js` (N1)<br>`rehearse-billing-migration.js` (场景6) - **PASS** |
| **N2** | 付款前变更互斥 | 两份升级报价在付款前均创建订单：第二份下单前被账户级套餐占位拦截；若两笔已收冲突单结算，第二笔安全进入 `audit_required`，总余额保持 677 分不超发至 934 分。 | 下单路由缺乏付款前账户级套餐变更占位；订单读回丢失快照绑定导致履约 guard 未生效。 | `payment-routes.js` (前置互斥检查)<br>`subscription-service.js` (履约 `expectedPlanId` guard) | `billing-v2-closeout.test.js` (N2) - **PASS** |
| **N3** | 连续升级精度 | 31天周期剩3天连续升级（轻量→专业→业务），真实订单数据库读回：精确补发 30 + 106 = 136 分，非 107 也非 137 分。 | 订单持久化与读回未贯穿 `cumExact` 快照，履约读取未定义字段导致每次重置为0。 | `payment-repository.js` (`buildCanonicalOrderSnapshot`)<br>`subscription-service.js` | `billing-v2-closeout.test.js` (N3) - **PASS** |
| **N4** | 年付升级未来权益 | 专业版年付 (400分/月) 升级业务版：当期补发 257 分，未来 5 期每期严格按业务版承诺 1500 分发放，实际推进下一期确发 1500 分。 | 路由将当期增量 257 写入 `plan_credits`，升级履约误用当期值覆盖未来分期额度。 | `payment-routes.js` (分离月度与当期)<br>`subscription-service.js` (`targetMonthlyCredits`) | `billing-v2-closeout.test.js` (N4) - **PASS** |
| **N5** | 续费成交快照锁定 | 续费成交承诺 400 分/月，下单后商品目录被改价或改额度至 900 分：排期激活严格履约 400 分，不回退目录默认值。 | 续费订单即时发放为0导致回退 `order.planCredits \|\| plan.credits` 当前目录。 | `payment-repository.js` (`snapshot.monthlyCredits`)<br>`subscription-service.js` | `billing-v2-closeout.test.js` (N5) - **PASS** |
| **N6** | 已付未履约重放恢复 | 订单置为 `paid + unfulfilled`（如发券崩溃重试）：对账重放或查单幂等恢复履约恰好到账 25 分，不因 `alreadyPaid` 直接忽略。 | `settlePaidPaymentOrder` 见 `order.status === 'paid'` 立即提前返回，忽略未履约状态。 | `payment-repository.js` (`settlePaidPaymentOrder` 恢复分支) | `billing-v2-closeout.test.js` (N6) - **PASS** |
| **N7** | 任务跨期批次预占 | 周期50+永久100，到期前1秒启动任务预占1分周期批次，到期后1秒完成：结算锁定周期批次，永久积分严格保持100分。 | 趋势分析仅标记表状态未调用批次预占，完成时执行 fresh spend 误扣永久批次；时钟未统一致用例脱节。 | `credit-ledger.js` (`task_credit_reservations`)<br>`trend-analysis-repository.js` | `billing-v2-closeout.test.js` (N7) - **PASS** |
| **N8** | 预占批次到期流水 | 50分周期批次预占30分跨到期点：未预占20分生成 -20 `cycle_expire` 到期流水；任务成功结算30分，整体对账 30+20=50 分不漏不重。 | `rescanExpiredLots` 跳过带有预占的到期批次，任务完成后剩余未预占部分永不产生流水。 | `credit-ledger.js` (`rescanExpiredLots` 拆分失效) | `billing-v2-closeout.test.js` (N8) - **PASS** |
| **N9** | 排期激活发券流水 | 续费排期到期自动激活发放400分：同事务生成一笔 `cycle_grant` 发放流水，订单变为 fulfilled，服务与批次一致。 | 排期激活逻辑创建订阅与批次，但遗漏了向 `credit_events` 写入首期发放事实。 | `subscription-service.js` (`advanceSubscriptionLifecycles`) | `billing-v2-closeout.test.js` (N9) - **PASS** |
| **E1** | 下单幂等性 | 同一购买意图同键重试返回同一订单；同键不同商品/报价报 409 冲突。 | 报价消费在幂等查询之前，重放被报价失效拦截。 | `payment-routes.js` | `billing-v2-closeout.test.js` (E1) - **PASS** |
| **E2** | 渠道预检与旧SKU停售 | 渠道关闭或网关不可用在消费报价前返回 503；新下单必须传 quoteId，禁止绕过报价购买旧 SKU。 | 旧路由允许直接传 planId 购买旧单月版/包年版。 | `payment-routes.js` | `billing-v2-closeout.test.js` (E2) - **PASS** |
| **E3** | 支付验签与防篡改 | 拒绝金额篡改、商户号错配、假通知；合法旧订单保留一次性履约。 | 校验规则在极端异常下需保持防御性。 | `payment-routes.js` / `payment-repository.js` | `billing-v2-closeout.test.js` (E3) - **PASS** |
| **E4** | 年付生命周期与重置 | 12期逐月发放，无第13期，跨期时 `upgrade_cumulative_exact` 与整数累计同时重置为0。 | 跨期推进漏重置浮点累计字段。 | `subscription-service.js` | `billing-v2-closeout.test.js` (E4) - **PASS** |
| **E5** | 多场景迁移演练 | 全新库、旧库升级、V13增量、已执行V14增量、在途预占结算、纯cycle账户升级全部演练通过。 | 需全面覆盖各版本演进路径。 | `rehearse-billing-migration.js` (6大场景) | `rehearse-billing-migration.js` - **PASS** |
| **E6** | 真实多进程并发竞争 | 异步子进程、起跑屏障、同一文件级 SQLite WAL 数据库并发竞争15积分，严格仅1进程成功，无超扣。 | 历史测试采用同步 `execFileSync` 冒充并发且未调项目模块。 | `helpers/concurrency-worker.cjs`<br>`billing-v2-closeout.test.js` (E6) | `billing-v2-closeout.test.js` (E6) - **PASS** |
| **E7** | 账务统计与导出分类 | `cycle_expire` 不计入消费量；流水按显式 actionType 区分；分页与搜索总数正确；CSV 防注入。 | 历史统计将负数 delta 一律计为消费，导致到期夸大消费量。 | `payment-routes.js`<br>`admin-repository.js` | `billing-v2-closeout.test.js` (E7) - **PASS** |
