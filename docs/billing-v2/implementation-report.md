# RedBase 套餐与积分 V2 实施报告

## 1. 概述与交付范围

根据 `design-reference/redbase-billing-v2/IMPLEMENTATION_PROMPT.md` 规范与 `RedBase-credits-preview-v2.html` 已确认原型，本项目在本地独立分支 `codex/billing-v2-subscription-wallet` 完成了“周期套餐 + 永久积分加油包”完整改造，实现了前后端正式闭环。

本次交付全部在本地开发测试环境中进行，未推送到远程仓库、未合并主干分支、未部署到生产环境，未发生真实扣款。

---

## 2. 关键修改与文件映射

| 模块 | 文件路径 | 职责与修改内容 |
| --- | --- | --- |
| **套餐目录与定价** | `src/server/billing/catalog.js` | 服务端版本化定价快照 (`v2_20261016`)，定义轻量版、专业版、业务版三档月付/年付套餐，以及三档永久积分加油包；隔离历史 SKU (`business-monthly`/`business-annual`)。 |
| **时区与周期工具** | `src/server/billing/period-utils.js` | 支持 `Asia/Shanghai` 时区日历月算法 (`addCalendarMonths`)、月末锚点保持 (1月31日→2月28日/29日→3月31日恢复)、闰年判断及可注入测试时钟。 |
| **不可变报价引擎** | `src/server/billing/quote-service.js` | 服务端权威计价，实现同周期升级精确补差与本期增量计算；年付升级剩余期计算；待生效订单排他约束与报价时效控制 (`verifyAndConsumeQuote`)。 |
| **积分账本与批次** | `src/server/billing/credit-ledger.js` | 管理 `credit_lots` 批次，实现“先消耗最早到期、永久积分最后”的 FIFO 扣减规则、原子预占与结算释放；维护 `users.credits` 兼容缓存。 |
| **订阅与调度服务** | `src/server/billing/subscription-service.js` | 管理当前活跃订阅、待生效安排 (`subscription_schedules`) 与年付 12 期逐期发放记录 (`subscription_grants`)；实现定时与启动补扫激活。 |
| **数据库版本迁移** | `src/server/db/migrations.js` | 新增 Migration Version 13 (`billing-v2-subscription-ledger`)，原子创建订阅、调度、发券计划、批次账本、报价与订单扩展字段。 |
| **账本接入与扣分** | `src/server/db/repositories/admin-repository.js` | 扣除与退款链路统一接入批次账本 (`spendCreditsFromLots`)，补齐旧余额开账迁移保障，消除余额直接覆盖旁路。 |
| **支付与履约闭环** | `src/server/db/repositories/payment-repository.js` | 订单快照写入 V2 字段，履约状态与付款状态解耦；支付成功原子触发 `fulfillPaymentOrder` 或旧订单永久积分履约。 |
| **支付与账本路由** | `src/server/api/payment-routes.js` | 新增 `GET /api/billing/wallet`、`POST /api/billing/quote`、`GET /api/billing/ledger`、`GET /api/billing/ledger/export` (带 CSV 公式注入防范)；订单创建接入报价校验。 |
| **启动补扫与调度** | `src/server/index.js` | 服务启动时自动执行旧用户余额迁移补齐 (`migrateAllLegacyUsers`) 与周期生命周期推进，注册 60 秒定期维护定时器 (`unref`)。 |
| **前端 API 契约** | `frontend/src/features/billing/api.ts` | 声明 V2 套餐、加油包、账本流水、钱包概览、报价与订单接口类型与请求封装。 |
| **前端主页面** | `frontend/src/features/billing/views/RechargeView.vue` | 将 V2 原型转为正式 Vue 页面：4 个标签页（周期套餐/积分加油包/积分明细/订单记录）、月年付切换、结算弹窗、二维码支付轮询、消耗规则/明细/安排弹窗；清除所有 demo mock 数据。 |
| **工作台入口对齐** | `frontend/src/app/views/WorkspaceShell.vue` | 侧栏导航不增加入口；点击头像弹出个人中心（展示当前套餐、到期时间、本期/永久积分及“套餐与积分”、“查看订单”入口）；移除旧售卖文案。 |

---

## 3. 核心业务规则与标准算例验证

### 3.1 V2 标准升级算例
在 `tests/credits/billing-v2.test.js` 中完整验证：
- **当前状态**：专业版月付，2026-09-23 14:00 至 2026-10-23 14:00（Asia/Shanghai），整期 ¥999，400 积分/月
- **报价时间**：2026-10-16 14:00，服务总长 30 天，剩余 7 天（占比 7/30）
- **目标档位**：业务版月付，整期 ¥2,999，1,500 积分/月
- **算例结果**：
  - 差价补款：`(299900 - 99900) × 7 / 30 = 46666.67` → 四舍五入到分精确得到 **¥466.67** (46667 分)
  - 本期补发：`ceil((1500 - 400) × 7 / 30) = ceil(256.67)` → 向上取整精确得到 **257 积分**
  - 本期可用：原 120 + 补发 257 = **377 积分**
  - 永久可用：**300 积分**保持不变
  - 总可用额度：377 + 300 = **677 积分**
  - 原服务到期日保持 2026-10-23 14:00 不变，已用 280 记录完整保留

### 3.2 待生效安排与排他约束
- 同周期续费、降档、月付年付切换：在当前已购服务结束后生效，写入 `subscription_schedules`。
- 数据库唯一约束：`UNIQUE(user_id) WHERE status = 'scheduled'`，每个账户严格保证最多一个待生效套餐，已有待生效订单时拒绝再次购买周期套餐，引导至“查看安排”；加油包购买不受排他限制。

### 3.3 积分批次与 FIFO 消耗
- 批次区分 `cycle`（当期有效，`expires_at` 精确到期）、`upgrade`（补发，随当期到期）、`topup`（永久有效，`expires_at = NULL`）、`legacy`（历史保留，永久有效）。
- 排序规则：优先消耗最早到期的批次，最后消耗永久批次（`CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END ASC, expires_at ASC, id ASC`）。

---

## 4. 测试与验证结果

1. **V2 业务与边界集成测试** (`tests/credits/billing-v2.test.js`)：
   - 包含 V2 标准升级算例、闰年与月末日历计算、年付 12 期发券、待生效排他约束、批次 FIFO 消耗、历史余额迁移。
   - 结果：**6 passed (6), 0 failed**。
2. **计费与支付回归测试** (`tests/credits`, `tests/api/payment-routes.test.js`, `tests/repositories/reconcile-orders.test.js`)：
   - 结果：**56 passed (56), 0 failed**。
3. **前端 TypeScript 类型检查** (`npm run typecheck:frontend`)：
   - `vue-tsc --noEmit -p tsconfig.json`：**0 errors**。
4. **前端组件与视觉测试** (`npm run test:frontend`)：
   - 结果：**57 files passed (57), 412 tests passed (412)**。
5. **前端生产构建** (`npm run build`)：
   - 生成 `dist/public`，包含 admin, app, index 3 处入口及完整静态产物，**打包成功**。
6. **代码检查** (`npm run check`)：
   - 全部包含 V2 计费核心模块的语法检查通过，**退出码 0**。

---

## 5. 环境差异与限制说明

- **支付宝与微信支付真实凭据**：
  由于本地运行环境未配置具备商户权限的实名微信/支付宝商户密钥进行真实扣款，自动化测试与本地验证使用已配置好的 `FakeAlipayProvider` 与 `FakeWxpayProvider` 以及沙箱签名校验机制。
  真实支付渠道待线上商户密钥与回调外网地址具备后进行最终实测。代码中已保证所有回调签名校验、金额核对与幂等机制 100% 沿用生产标准。
