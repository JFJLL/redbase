# RedBase 短信注册/找回密码 + 支付宝电脑网站充值 集成分析（分析闸门）

日期：2026-08-04 ｜ 分支：`codex/redbase-sms-alipay` ｜ 基线：`b268625dd5c8d4d56d96b812bdb34d020f9e14bd`（origin/master；任务书记录的 50f8f2d 是其直接父提交，仅差一个 docs 提交，见 PROGRESS.md）

## 0. 结论（闸门判定）

- 现有 `users` / `sessions` / `credit_events`（以及 brands/generations/product_images/image_jobs/analyses/trends/ideas 等）零丢失：`isSchemaCurrent()`/`hasCurrentStoreSchema()` 保持原样，当前 schema 的数据库不会进入快照重建路径；新增表只通过版本化 `schema_migrations` 追加创建。旧 `verification_codes` 明文表按任务要求清空但保留空表。
- 锁定依赖：`alipay-sdk@4.14.0`（CommonJS：`const { AlipaySdk } = require('alipay-sdk')`）、`@alicloud/dysmsapi20170525@4.6.0`（CommonJS：`require('@alicloud/dysmsapi20170525')`，客户端类在 `.default`，请求模型为 `SendSmsRequest`）。两个包都已核实为最新版且为官方导出形态。
- 闸门通过；后续按本文档实施。实施期间仅改任务书允许的文件清单（见 §7），其余文件只读。

## 1. 现状与真实调用链

### 1.1 当前认证链路（基线实测）

1. `server.js` → `src/server/index.js:start()` → `loadAppConfig()` → `ensureStore()`（`initializeDatabaseSchema` → `ensureSchemaUpgrades` → `migrateSchemaIfNeeded` → `ensureDatabaseIndexes` → 规范化重写）→ `createApiHandler`。
2. `POST /api/auth/send-code`：`handleAuthRoutes` 生成 `100000..999999` 的 `Math.random()` 6 位码，明文写入 `verification_codes(phone, code, expires_at)`，响应体直接返回 `demoCode`（生产也返回）。
3. `POST /api/auth/register`：只校验 phone/name/password 与 `phoneExists`，**不校验任何验证码**，`createUserWithSession` 事务内 `allocateCounter("nextUserId")` + 建用户 + 删旧 `verification_codes` + 建 session，Set-Cookie `redbase_session`（HttpOnly、Path=/、SameSite=Lax、Max-Age 30 天）。
4. `POST /api/auth/login`：`verifyAndMigratePassword`（scrypt v1，旧明文自动迁移），建 session、写 Cookie。
5. `GET /api/session` / 各业务路由：`getSessionToken`（Cookie 优先，兼容 `x-session-token`）→ `findUserBySessionToken`。
6. `migrations.js`：仅当 `users` 存在且 `isSchemaCurrent()` 为 false 时，快照→DROP 旧表→重建→写回。DROP 列表不包含 `credit_events`/`generations`/`product_images`/`image_jobs`/`creator_materials`/`trend_analysis_requests`/`excellent_*`；users/sessions/brands/analyses/trends/ideas 经快照写回。

### 1.2 目标调用链（本任务新增）

短信注册：
`前端注册表单` → `POST /api/auth/send-code {phone, purpose:"register"}` → 限流检查（phone/IP/global 窗口计数）→ `verification-service` 生成密码学随机码 → HMAC-SHA256(pepper, purpose:phone:code) 存 `sms_verification_challenges` → provider（aliyun/fake）发送 → 成功后更新行（重发使旧码失效）；失败保留旧码。
`POST /api/auth/register {phone,name,password,code}` → 校验 purpose=register 的未消费/未过期/尝试<5 的 challenge → 同事务消费 challenge + 建用户 + 建 session + 写 Cookie。

短信重置：
`POST /api/auth/reset-password/send-code {phone}`（purpose=reset_password）→ 统一响应防枚举。
`POST /api/auth/reset-password {phone,code,password}` → 校验后同事务：更新密码、DELETE 该用户全部 sessions、清 Cookie；手机号不存在时同样消费/删除 challenge 并返回相同响应。

支付宝充值：
`GET /api/billing/recharge-plans`（登录）→ 仅返回显式配置套餐（无配置返回空，前端隐藏入口）。
`POST /api/payments/alipay/orders {planId,idempotencyKey}`（登录）→ 服务端套餐快照（金额分/积分）+ 严格十进制转分 → 生成不可预测 `out_trade_no` → 插入 `payment_orders`（created→pending）→ `pageExecute('alipay.trade.page.pay','GET',{bizContent,returnUrl,notifyUrl})` 生成支付 URL（仅返回给前端一次，不落库不写日志）。
`GET /api/payments/alipay/return?...`（支付宝同步回跳）→ 验签+字段校验，但**永不入账**，仅刷新/展示状态。
`POST /api/payments/alipay/notify`（支付宝异步通知，form-urlencoded）→ `checkNotifySignV2` 验签 → 校验 app_id/seller_id/out_trade_no/total_amount/trade_status/trade_no → 同步事务条件更新 + 唯一约束完成 paid + `users.credits` + `credit_events(action_type='alipay_recharge')` → 纯文本 `success`。
`scripts/reconcile-alipay-orders.js` → 遍历 pending/created 订单 → SDK `curl('POST','/v3/alipay/trade/query',{body:{out_trade_no}})` 查单 → 复用同一 settle 事务。
`GET /api/payments/orders` / `GET /api/payments/orders/:outTradeNo`（本人）→ 订单/状态查询。
`GET /api/payments/fake/alipay/settle?...`（仅 NODE_ENV=test + fake 显式注入）→ fake 结算页，走与 notify 相同的服务函数。

## 2. SDK / 配置契约

### 2.1 锁定依赖（package.json dependencies，精确版本）

- `alipay-sdk@4.14.0`：Node >= 18.20；CommonJS 导出为 `exports.AlipaySdk`（README 明确 v4 变更：`const { AlipaySdk } = require('alipay-sdk')`）。
  - `new AlipaySdk({ appId, privateKey, alipayPublicKey, gateway, timeout, keyType })`（公钥模式；验签必须配 `alipayPublicKey`）。
  - `pageExecute(method, httpMethod, bizParams)`：`pageExecute('alipay.trade.page.pay', 'GET', { bizContent, returnUrl, notifyUrl })` 返回完整 GET URL（含 sign）。
  - `checkNotifySignV2(postData)`：通知验签，不预先 decode value（官方推荐）。
  - `curl('POST', '/v3/alipay/trade/query', { body: { out_trade_no } })`：返回 `{ data, responseHttpStatus, traceId }`；查单用 curl，不用废弃的 `exec`。
- `@alicloud/dysmsapi20170525@4.6.0`：官方 Node SDK，CommonJS 为 `require('@alicloud/dysmsapi20170525')`；客户端类 `Dysmsapi.default`，请求 `new Dysmsapi.SendSmsRequest({ phoneNumbers, signName, templateCode, templateParam })`，调用 `client.sendSms(request)`（async）。构造配置走 `@alicloud/openapi-core` 的 `Config`（`endpoint: 'dysmsapi.aliyuncs.com'` + accessKey 等）。
- 直接 import 的精确依赖仅上述两个；其余依赖沿用现有 `better-sqlite3`、`crypto`（Node 内置）。

### 2.2 配置项（config.js + config.local.example.json 占位；真实密钥只走 env/config.local.json）

```jsonc
{
  "sms": {
    "provider": "disabled",            // "aliyun" | "fake" | "disabled"
    "accessKeyId": "", "accessKeySecret": "",
    "signName": "", "templateCode": "",
    "endpoint": "dysmsapi.aliyuncs.com",
    "pepper": "",                       // 必填；HMAC 校验码/脱敏 IP 用
    "codeTtlMs": 300000, "resendCooldownMs": 60000, "maxAttempts": 5,
    "limits": { "phonePerHour": 5, "phonePerDay": 10, "ipPerHour": 20, "ipPerDay": 100, "globalPerDay": 1000 },
    "fakeAllowed": false                // 显式注入；仅 NODE_ENV=test 且为 true 时才启用 fake
  },
  "alipay": {
    "enabled": false,                   // 新支付入口门；notify/query 仍按需处理存量 pending
    "provider": "disabled",             // "alipay" | "fake" | "disabled"
    "appId": "", "privateKey": "", "alipayPublicKey": "", "sellerId": "",
    "gateway": "https://openapi.alipay.com", "timeoutMs": 5000,
    "returnUrl": "", "notifyUrl": "", "keyType": "PKCS8",
    "fakeAllowed": false
  },
  "billing": { "rechargePlans": [] },   // [{id,name,credits,amountFen}]；无显式价格时隐藏入口并拒绝下单
  "security": { "trustedProxies": [] }  // IP 限流仅信任这些代理的 X-Forwarded-For
}
```

- 环境变量：`SMS_PROVIDER`、`SMS_ALIYUN_ACCESS_KEY_ID`、`SMS_ALIYUN_ACCESS_KEY_SECRET`、`SMS_SIGN_NAME`、`SMS_TEMPLATE_CODE`、`SMS_PEPPER`、`SMS_FAKE_ALLOWED`、`ALIPAY_ENABLED`、`ALIPAY_PROVIDER`、`ALIPAY_APP_ID`、`ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY`、`ALIPAY_SELLER_ID`、`ALIPAY_FAKE_ALLOWED`、`RECHARGE_PLANS_JSON`、`TRUSTED_PROXIES`。
- 硬约束：生产 provider 默认 disabled；fake 仅 `NODE_ENV=test && sms.fakeAllowed/alipay.fakeAllowed` 显式注入；无配置时不发真实短信/不创建真实扣款。

## 3. API 契约（新增/变更）

| 方法/路径 | 认证 | 请求 | 响应 | 说明 |
|---|---|---|---|---|
| POST /api/auth/send-code | 无 | `{phone, purpose}` | 200 `{message, demoCode?}` | purpose ∈ register/reset_password；fake+test 显式注入时返回 demoCode，其余环境绝不返回 |
| POST /api/auth/register | 无 | `{phone,name,password,code}` | 201 `{user}` / 400 | 原子消费 register challenge；已有 phone 仍返回“已注册” |
| POST /api/auth/reset-password/send-code | 无 | `{phone}` | 200 `{message}` 统一 | 防枚举；手机号不存在也成功 |
| POST /api/auth/reset-password | 无 | `{phone,code,password}` | 200 `{ok:true}` 统一 | 校验后改密 + DELETE 该用户全部 session + 清 Cookie |
| GET /api/billing/recharge-plans | 登录 | - | `{plans:[{id,name,credits,amountYuan}]}` | 无配置返回 []；前端隐藏入口 |
| POST /api/payments/alipay/orders | 登录 | `{planId,idempotencyKey}` | 201 `{order,payUrl}` | 幂等键必填；payUrl 仅此响应返回 |
| GET /api/payments/alipay/return | 无（登录态可读） | 支付宝同步回跳参数 | 302 → 前端充值页 | 只更新展示状态，**永不入账** |
| POST /api/payments/alipay/notify | 无（验签） | form-urlencoded | 纯文本 `success`/`failure` | 验签+字段校验后原子 settle；重复/乱序只入账一次 |
| GET /api/payments/orders | 登录 | - | `{orders:[...]}` | 仅本人 |
| GET /api/payments/orders/:outTradeNo | 登录 | - | `{order}` / 404 | 仅本人；他人/不存在同响应 |
| POST /api/payments/alipay/orders/:outTradeNo/close | 登录 | - | 200 `{order}` | 仅本人且未 paid 时 closed |
| GET /api/payments/fake/alipay/settle | 无 | `{outTradeNo,status}` | HTML/JSON | 仅 test+fake；复用 notify settle 路径 |

## 4. 威胁模型与对策

| 威胁 | 对策 |
|---|---|
| 验证码明文泄露/DB 拖库 | 只存 `HMAC-SHA256(pepper, purpose:phone:code)`；pepper 必填，缺失即服务不可用（fail-closed） |
| 手机号/账号枚举 | 注册：已存在统一“该手机号已注册”（业务必须）；重置：send/reset 均统一成功响应；日志脱敏 `maskPhone` |
| 验证码爆破 | 每 challenge 最多 5 次尝试（尝试后递增）；超限即作废 |
| 短信轰炸 | phone 5/小时、10/天；IP 20/小时、100/天；全局 1000/天；窗口计数原子递增；60 秒重发冷却 |
| IP 伪造绕过限流 | 仅信任 `security.trustedProxies` 中代理的 X-Forwarded-For；未配置代理时用 socket 地址；IP 以 pepper HMAC 存储 |
| 发送失败重放/覆盖 | provider 抛错/非成功码→不更新 challenge（旧有效码保留）；成功后才使旧码失效 |
| 旧明文 verification_codes 遗留 | 部署迁移清空旧表（保留空表），新流程完全不读写它 |
| 重置密码后旧 session 仍有效 | 改密同事务 DELETE 全部 sessions + 清当前 Cookie |
| 通知伪造/重放 | `checkNotifySignV2` + app_id/seller_id/out_trade_no/total_amount/trade_status/trade_no 全量校验；失败返回非 success 让支付宝重试 |
| 金额篡改 | 金额只信任服务端套餐快照（amount_fen/credits 创建时落库）；通知金额必须等于快照金额 |
| 重复/并发/乱序入账 | `UPDATE ... WHERE status IN ('pending','expired','created')` 条件更新 + `trade_no` 非空唯一 + `credit_event_id` 唯一 + better-sqlite3 同步事务；迟到支付允许 expired→paid |
| 同步回跳伪造入账 | return 路径永不写 credits/credit_event；只有 notify 或对账查单可入账 |
| 不可预测 out_trade_no | `crypto.randomBytes`（如 `redbase_<16字节hex>`）并 DB UNIQUE |
| 幂等创建重复 | `(user_id, idempotency_key)` UNIQUE；重复请求返回既有订单（同 key+plan） |
| 普通用户看全局订单 | 查询强制 `WHERE user_id = ?`；越权与不存在返回一致 |
| 签名 URL 泄露 | payUrl 只存内存/单次响应；DB 与日志均不记录含 sign 的 URL |
| 日志敏感信息 | 手机号脱敏、验证码不落日志、不打印私钥/AK；沿用 `buildApiUserLog`/`buildApiRequestLog` 机制 |
| 关闭充值入口后丢单 | `alipay.enabled=false` 只关创建入口；notify/query/reconcile 常驻直到 pending 清零 |
| 生产误用 fake | `createSmsProvider/createAlipayProvider` 仅在 `NODE_ENV==='test'` 且显式 `fakeAllowed` 时允许 fake |

## 5. 表结构 / 索引 / 状态机

### 5.1 版本化迁移（新增 `schema_migrations`，独立于旧 isSchemaCurrent）

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

- `isSchemaCurrent()` / `hasCurrentStoreSchema()` **不改**（避免旧快照重建被新表触发）。
- `ensureStore()` 在 `migrateSchemaIfNeeded()` 之后调用 `applyVersionedMigrations()`：逐版本事务执行 DDL + 写入版本号；幂等（版本已存在跳过）。

### 5.2 v1 迁移：短信挑战与限流

```sql
CREATE TABLE IF NOT EXISTS sms_verification_challenges (
  id INTEGER PRIMARY KEY,
  purpose TEXT NOT NULL,               -- register | reset_password
  phone TEXT NOT NULL,
  code_hmac TEXT NOT NULL,             -- HMAC-SHA256(pepper, purpose:phone:code)
  expires_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  UNIQUE (purpose, phone)
);
CREATE INDEX IF NOT EXISTS idx_sms_challenges_expiry ON sms_verification_challenges(expires_at_ms);

CREATE TABLE IF NOT EXISTS sms_send_rate_limits (
  scope TEXT NOT NULL,                 -- phone | ip | global
  bucket_key TEXT NOT NULL,            -- phone / HMAC(ip) / 'global'
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, bucket_key, window_start_ms)
);
CREATE INDEX IF NOT EXISTS idx_sms_rate_window ON sms_send_rate_limits(scope, window_start_ms);

DELETE FROM verification_codes;        -- 部署清空旧明文，保留空表兼容
```

### 5.3 v2 迁移：支付订单

```sql
CREATE TABLE IF NOT EXISTS payment_orders (
  id INTEGER PRIMARY KEY,
  out_trade_no TEXT NOT NULL UNIQUE,   -- 不可预测、全局唯一
  user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_name TEXT NOT NULL,
  plan_credits INTEGER NOT NULL,
  amount_fen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  provider TEXT NOT NULL DEFAULT 'alipay',
  trade_no TEXT NOT NULL DEFAULT '',
  credit_event_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  last_notified_at TEXT NOT NULL DEFAULT '',
  notify_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',   -- 仅存审计字段，不含签名/私钥
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (credit_event_id) REFERENCES credit_events(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_user_idem
  ON payment_orders(user_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_trade_no
  ON payment_orders(trade_no) WHERE trade_no <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_credit_event
  ON payment_orders(credit_event_id) WHERE credit_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_orders_user_status
  ON payment_orders(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status_expiry
  ON payment_orders(status, expires_at);
```

### 5.5 v3 迁移：订单人工审计标记（发布审查修复）

```sql
ALTER TABLE payment_orders ADD COLUMN audit_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE payment_orders ADD COLUMN audit_at TEXT NOT NULL DEFAULT '';
```

- `closed_provider_paid`：本地已关闭但支付宝侧确认已付款（通知或对账发现），系统不自动入账、不静默确认，写入人工审计并让通知持续重试。
- `settle_blocked`：settle 条件更新未生效但订单未 paid 的兜底审计。

### 5.4 订单状态机

`created → pending → paid | closed | expired | failed`

- `created`：下单成功、尚未生成/返回支付地址。
- `pending`：已生成支付地址（同一创建请求内即转 pending）。
- `paid`：**仅** notify 验签通过或对账查单确认 TRADE_SUCCESS/TRADE_FINISHED 后，由原子 settle 事务写入；迟到支付允许 `expired → paid`。
- `closed`：本人 close 接口（未 paid 时）；或回滚时关闭新支付入口（不再创建）。close 接口先调用支付宝 `alipay.trade.close`：支付宝返回已支付则直接结算入账；网关缺失/关闭失败则本地拒绝关闭。closed 订单收到 TRADE_SUCCESS 通知返回 failure 并记录 `closed_provider_paid` 审计，绝不返回 success 吞单。
- `expired`：超过 `expires_at` 且未 paid（惰性判定 + 对账脚本）。
- `failed`：对账/查单确认失败或超时人工审计后标记；首期不自动退款/扣回积分，退款进人工审计。

## 6. 迁移 / 备份 / 回滚

1. 部署前备份（在服务器执行）：`cp data/redbase.sqlite{,-wal,-shm} data/backup/redbase-$(date +%F).sqlite*`（或 `VACUUM INTO` 一致性副本）；必须确认备份文件 sha256 落盘。
2. 启动新代码：`ensureStore` 自动应用 v1/v2（追加建表 + 清空旧明文验证码 + 写 schema_migrations）；旧表不重建。
3. 验证：`SELECT COUNT(*) FROM schema_migrations`；users/sessions/credit_events 行数不变；`verification_codes` 为空但表存在。
4. 回滚（代码级）：不部署即可；已部署则恢复旧代码 + 旧配置，`payment_orders`/`sms_verification_challenges` 新表无副作用（旧代码不读它们）。
5. 回滚（业务级，正式回滚方案）：`alipay.enabled=false` 与 `sms.provider=disabled` 关闭新入口；notify 路由与 `reconcile-alipay-orders.js` 继续处理存量 pending 直到清零；已入账订单保留，退款走人工审计。
6. 对账覆盖范围（发布审查修复）：对账先查支付宝再判断过期；查询范围包括 `created/pending/expired/closed`（未审计）；过期但已付款 → expired→paid 自动补账；closed 但已付款 → 人工审计不自动入账。

## 7. 允许修改的文件清单（硬约束）

- 根：`package.json`、`package-lock.json`、`config.local.example.json`。
- 后端：`src/server/config.js`、`index.js`、`api.js`、`api/auth-routes.js`、新增 `api/payment-routes.js`、`db/schema.js`（仅加版本化迁移辅助/新表 DDL）、`db/migrations.js`（仅加版本化迁移入口）、认证/计费 repository（`db/repositories/auth-repository.js`、新增 `db/repositories/verification-repository.js`、`db/repositories/payment-repository.js` 或等价）、新增 `src/server/auth/verification-service.js`、新增 `src/server/integrations/sms/**`、新增 `src/server/integrations/alipay/**`、新增 `src/server/billing/**`。
- 脚本：`scripts/reconcile-alipay-orders.js`、`scripts/smoke-api.js`。
- 前端：认证/充值功能及必要 router/nav/types（`frontend/src/features/auth/**`、`frontend/src/features/billing/**`、`frontend/src/app/router.ts`、`frontend/src/app/views/WorkspaceShell.vue`、`frontend/src/shared/types/api.ts` 等）。
- 测试：与上述功能对应的 `tests/**` 与 `frontend/src/**/__tests__/**`（新增用例；不改基线断言，测试数不得低于基线）。
- 过程文件：`docs/sms-alipay-integration-analysis.md`、`PROGRESS.md`、`BLOCKED.md`（本任务章节）。
- 禁止改：`verification-policy.json`、`scripts/verify-change.ps1`、AI/趋势/管理功能、`data/`、真实 `config.local.json`、`.env`、部署/生产配置。

## 8. 测试矩阵（任务4 验收映射）

| 验收项 | 测试 |
|---|---|
| 验证码 6 位/5 分钟/60 秒重发/最多 5 次 | verification-service 单测 + API 集成（过期、冷却、attempts、重发后旧码失效） |
| 发送失败保留旧码、provider 失败不算成功 | fake provider 注入失败 + 断言 challenge 未变 |
| 防枚举（重置统一响应） | 存在/不存在手机号相同 status/body；日志脱敏 |
| 注册原子消费 + 建 session；旧 session 删除 | API 集成：register 消费 challenge、错误码不可复用；reset 后原 session 401 |
| 支付创建幂等/不可预测 out_trade_no/套餐快照 | payment-repository + API：同 key 返回同一订单；无套餐拒绝 |
| 验签失败/错商户/错金额/未知单/重复 trade_no | notify 集成矩阵（fake 签名生成 + 篡改） |
| 返回页不入账 | return 后 credits/credit_event 不变 |
| 迟到/乱序/20 并发只入账一次 | 并发 notify + 唯一约束断言；expired→paid 单测 |
| 迁移副本零丢失 | data 测试：复制 users/sessions/credit_events 的 DB 跑 ensureStore，行/值逐字段一致；schema_migrations 幂等 |
| 前端注册/重置/充值状态 | vitest：验证码字段/倒计时/加载错误、忘记密码流、充值页隐藏与下单/状态 |
| 反向破坏（红→绿） | 破坏验签或 settle 条件→目标测试红；还原→全绿 |
| 浏览器验收 | Kimi 隔离 DB + fake provider：注册验证码、短信重置、充值下单/状态/本人订单/结算页 |
| 独立 reviewer | agent-review 证据（独立 reviewer 复核并附 artifact） |

## 9. 实施顺序与风险

1. 依赖与配置骨架（package.json、config.js、示例配置）。
2. 版本化迁移 + 验证码存储/限流/verification-service + SMS provider 适配（aliyun/fake/disabled）。
3. 注册/重置路由 + 前端认证改造。
4. 套餐配置 + payment_orders + 支付宝适配 + 下单/notify/return/close/查询路由 + 对账脚本。
5. 全量验收、红→绿、Kimi、reviewer、receipt。

最大风险（按优先级）：并发/乱序通知只入账一次（唯一约束+同步事务兜底）；迁移零丢失（isSchemaCurrent 不动 + 副本测试）；重置后旧 session 全部失效；fake provider 泄漏风险（双条件显式注入）。

## 10. 发布审查缺陷修复记录（2026-08-04 复审轮）

### P0 本地关闭后仍可能付款且通知返回 success 吞单

根因：close 仅本地改状态，未关闭支付宝交易；closed 订单收到 TRADE_SUCCESS 时 settle 条件更新 0 行但被当作“已处理”返回 success，用户付款后积分不发放且无重试。

修复：close 调用支付宝关闭交易（fake/real `closeTrade`）；支付宝已支付则结算入账；网关缺失或关闭失败则本地拒绝关闭（502/503）。closed 订单收到 TRADE_SUCCESS → 记录 `closed_provider_paid` 审计并返回 failure，支付宝持续重试、对账可见。

红→绿：新增 3 个测试（closed 后付款通知必须 failure+审计、close 已付订单必须 settle、无网关 close 必须拒绝），修复前 3 红，修复后 3 绿。

### P1 阿里云短信成功响应读取大写 Code

根因：官方 `SendSmsResponseBody` 字段为小写 `code`，代码读 `body.Code`，真实成功会被判为失败。

修复：`parseSendSmsResponse` 按 `body.code` 解析并导出纯函数测试。

红→绿：新增 4 个测试（小写 OK 成功、小写业务错误拒绝、大写 Code 不视为成功、空响应拒绝），修复前 3 红，修复后 4 绿。

### P2 对账先过期后查询，且只查 pending/created，漏单无法补账

根因：`reconcileOne` 先按过期标记 expired 再查支付宝；查询范围不含 expired/closed，过期后已付款的订单永久漏账。

修复：先查支付宝再判过期；查询 `created/pending/expired/closed` 且未审计；过期已付款自动补账（expired→paid）；closed 已付款进入人工审计。

红→绿：新增 3 个测试（过期已付款补账、过期未付款标记 expired、closed 已付款审计），修复前 3 红，修复后 3 绿。

### 补充说明

- fake provider `queryOrder` 修正为返回真实支付宝下划线契约（`trade_status/trade_no/total_amount`），此前返回 camelCase 导致对账测试无法驱动成功路径。
- 版本化迁移增至 v3；迁移零丢失测试断言更新为 `[1,2,3]`。

## 11. 发布审查第二轮：SDK 响应契约修复（2026-08-04）

### P3 官方 SDK 默认 camelcase=true，查单响应为驼峰字段

根因：`alipay-sdk` 默认 `camelcase: true`（官方 README 明确），`/v3/alipay/trade/query` 返回 `tradeStatus/totalAmount/tradeNo`；对账只读 `trade_status/total_amount/trade_no`，真实查询被当作未支付而标记 expired，积分不补。

修复：适配层（`RealAlipayProvider.queryOrder`）统一把响应规范化回线协议（snake_case）：`normalizeAlipayQueryData` 同时兼容驼峰与下划线，业务/对账不再依赖 SDK 形状。

红→绿：新增 5 个测试（camelCase 查询规范化、V3 关单成功响应、关单错误拒绝、驼峰已支付关单识别、真实驼峰形状的过期订单经对账自动补账）。修复前 4 红（含用户复现：过期已付款订单被误判 expired、积分不变），修复后 5 绿。

### P4 V3 关单成功响应只有 out_trade_no/trade_no

根因：`alipay.trade.close`（V3）成功响应仅含 `out_trade_no`、`trade_no`，没有 `trade_status` 也没有 `code=10000`；原实现读到空状态后抛“关闭订单失败：unknown”。

修复：`parseCloseTradeResult` 支持：错误响应（code/sub_code）抛错；`trade_status` 明确时按状态返回（已支付/已关闭）；只有 `out_trade_no/trade_no` 时视为关闭成功。

红→绿：上述 `alipay-sdk-contract.test.js` 中 3 个 close 用例，修复前 3 红，修复后 3 绿。
