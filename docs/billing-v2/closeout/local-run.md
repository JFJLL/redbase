# RedBase 套餐与积分 V2 本地复现与启动指南

## 1. 快速回归验证命令速查

在本地仓库根目录下，打开终端执行以下命令：

```powershell
# 1. 运行本轮收尾全量专项用例 (C1–C6, N1–N9, E1–E7)
node --test tests/credits/billing-v2-closeout.test.js

# 2. 运行计费、支付与对账全套回归测试 (94 项测试)
node scripts/run-node-tests.js tests/credits tests/api/payment-routes.test.js tests/repositories/reconcile-orders.test.js

# 3. 运行多场景数据迁移演练 (6 大演练场景，含 N1 周期无永久副本)
node scripts/rehearse-billing-migration.js

# 4. 运行历史数据库安全 dry-run 审计
node scripts/audit-and-repair-billing-v2.js

# 5. 执行全工程语法与类型检查
npm run check
npm run typecheck:frontend

# 6. 执行前端生产构建
npm run build

# 7. 运行真实浏览器自动化端到端测试与截图
node scripts/verify-closeout-browser-e2e.cjs
```

---

## 2. 本地隔离启动与业务查看方式

若需要在浏览器中手动查看“套餐与积分”页面并进行模拟下单体验，请按以下步骤操作：

### 步骤一：准备测试数据库与账号
运行以下命令初始化测试数据库（生成体验账号与测试会话）：
```powershell
node scripts/seed-ui-test-db.js
```
该脚本将在 `data/test-billing-ui.sqlite` 中准备好测试数据：
- **用户 ID**：1（测试体验账号）
- **会话 Token**：`test-session-v2`
- **初始资产**：专业版月付（当前可用 120 周期积分 + 300 永久积分）

### 步骤二：以测试网关配置启动服务端
```powershell
$env:PORT="3333"
$env:NODE_ENV="development"
$env:REDBASE_DB_FILE="data/test-billing-ui.sqlite"
$env:APP_CONFIG='{"alipay":{"enabled":true,"provider":"fake"},"wxpay":{"enabled":true,"provider":"fake"},"billing":{"rechargePlans":[]}}'
node server.js
```

### 步骤三：在浏览器中访问与体验
1. 打开浏览器，访问 `http://localhost:3333/app/billing`。
2. 打开开发者工具 Application -> Cookies -> `http://localhost:3333`，添加 Cookie：
   - Name: `redbase_session`
   - Value: `test-closeout-session`
   - Path: `/`
3. 刷新页面，即可进入“套餐与积分”管理工作台。
4. **功能体验路径**：
   - 切换“周期套餐”与“积分加油包”选项卡。
   - 点击“升级套餐”（补款 ¥466.67，补发 257 积分），核对弹窗中展示的精确补款与原到期日。
   - 勾选协议并点击“确认支付”，在弹窗中选择支付宝或微信支付。
   - 点击“订单记录”，查看不同状态（已到账、待生效、待核查）的订单卡片。
