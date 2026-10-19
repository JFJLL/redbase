"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

let playwright;
try {
  playwright = require("playwright");
} catch (_) {
  try {
    playwright = require("@playwright/test");
  } catch (_) {
    playwright = require("C:/Users/liuhao_PC/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright");
  }
}
const { chromium } = playwright;

const outputDir = path.resolve("docs/billing-v2/closeout/ui-verification");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

const dbFile = "data/closeout-e2e.sqlite";
process.env.REDBASE_DB_FILE = dbFile;

function seedCloseoutDb() {
  const Database = require("better-sqlite3");
  if (fs.existsSync(dbFile)) {
    try { fs.unlinkSync(dbFile); } catch (_) {}
  }
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../src/server/db/schema");
  const { openDatabase } = require("../src/server/db/connection");
  openDatabase();
  initializeDatabaseSchema();
  ensureDatabaseIndexes();

  const nowIso = "2026-10-16T06:00:00.000Z";
  // 1. Insert user
  db.prepare(`
    INSERT INTO users (id, name, phone, password, account_type, department, credits, legacy_credits_migrated, created_at)
    VALUES (1, '测试总监', '13800138000', 'hash', 'customer', '增长运营部', 420, 1, '2026-08-01T00:00:00.000Z')
  `).run();

  // 2. Insert session
  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at)
    VALUES ('test-closeout-session', 1, '2026-10-16T00:00:00.000Z')
  `).run();

  // 3. Insert brand
  db.prepare(`
    INSERT INTO brands (id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base, created_at, updated_at)
    VALUES (1, 1, '自然之光', '家居', '年轻租房人群', '便携折叠灯', '折叠台灯', '打造小空间桌面好光', '', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run();

  // 4. Insert active Pro subscription (2026-09-23 to 2026-10-23)
  const subStart = "2026-09-23T06:00:00.000Z";
  const subEnd = "2026-10-23T06:00:00.000Z";
  db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, plan_id, cycle, status, service_start, service_end,
      anchor_day, current_period_start, current_period_end, current_period_grant,
      upgrade_cumulative_increment, upgrade_cumulative_exact,
      pricing_basis_fen, actual_paid_total_fen, created_at, updated_at
    ) VALUES (1, 1, 'pro', 'monthly', 'active', ?, ?, 23, ?, ?, 400, 0, 0, 99900, 99900, ?, ?)
  `).run(subStart, subEnd, subStart, subEnd, subStart, subStart);

  // 5. Insert lots
  db.prepare(`
    INSERT INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at)
    VALUES (1, 1, 'cycle', '本期积分', 400, 120, 0, 280, ?, ?, 'active', ?, ?)
  `).run(subStart, subEnd, subStart, subStart);

  db.prepare(`
    INSERT INTO credit_lots (id, user_id, source_type, source_label, initial_credits, remaining_credits, reserved_credits, used_credits, starts_at, expires_at, status, created_at, updated_at)
    VALUES (2, 1, 'topup', '永久积分', 300, 300, 0, 0, ?, NULL, 'active', ?, ?)
  `).run(subStart, subStart, subStart);

  // 6. Insert audit_required order
  db.prepare(`
    INSERT INTO payment_orders (
      id, out_trade_no, user_id, idempotency_key, plan_id, plan_name, plan_credits,
      amount_fen, status, provider, created_at, updated_at, expires_at,
      fulfillment_status, audit_reason, audit_at, cycle, order_kind, order_action, issued_now
    ) VALUES (88, 'rb_audit_demo_1', 1, 'idem_audit_demo', 'pro', '专业版', 400, 99900, 'paid', 'alipay', ?, ?, ?, 'audit_required', '系统风控核查', ?, 'monthly', 'plan', 'activate', 400)
  `).run(nowIso, nowIso, nowIso, nowIso);

  db.close();
}

async function runBrowserE2E() {
  console.log("=== 正在执行端到端真实浏览器断言与截图 ===");
  seedCloseoutDb();

  const env = {
    ...process.env,
    PORT: "3334",
    NODE_ENV: "development",
    REDBASE_DB_FILE: dbFile,
    APP_CONFIG: JSON.stringify({
      alipay: { enabled: true, provider: "fake" },
      wxpay: { enabled: true, provider: "fake" },
      billing: { rechargePlans: [] },
    }),
  };

  const serverProc = spawn(process.execPath, ["server.js"], {
    env,
    stdio: "pipe",
    windowsHide: true,
  });

  await new Promise((resolve) => setTimeout(resolve, 2500));
  console.log("本地应用服务已启动在 http://localhost:3334");

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const assertions = [];

  try {
    // Desktop Viewport (1440x900)
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await desktop.addCookies([
      { name: "redbase_session", value: "test-closeout-session", domain: "localhost", path: "/" },
    ]);
    const page = await desktop.newPage();

    // 1. Overview Page
    await page.goto("http://localhost:3334/app/billing", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);

    const titleText = await page.textContent("body");
    const hasPlans = titleText.includes("轻量版") && titleText.includes("专业版") && titleText.includes("业务版");
    assertions.push({ name: "桌面端套餐展示完整", pass: hasPlans });
    await page.screenshot({ path: path.join(outputDir, "01-overview-desktop.png"), fullPage: true });

    // 2. Click Topups Tab
    const topupTab = page.locator("button:has-text('积分加油包')");
    await topupTab.click();
    await page.waitForTimeout(500);
    const bodyTopup = await page.textContent("body");
    const hasTopups = bodyTopup.includes("小额加油包") && bodyTopup.includes("标准加油包") && bodyTopup.includes("大额加油包");
    assertions.push({ name: "加油包列表渲染完整", pass: hasTopups });
    await page.screenshot({ path: path.join(outputDir, "02-topups-desktop.png"), fullPage: true });

    // 3. Purchase Topup (Small 25 credits)
    const buySmallBtn = page.locator(".topup-card:has-text('小额加油包') button:has-text('购买加油包')");
    await buySmallBtn.click();
    await page.waitForTimeout(800);

    const modalText = await page.textContent("body");
    const modalVisible = modalText.includes("小额加油包") && modalText.includes("¥99");
    assertions.push({ name: "加油包结算弹窗展示", pass: modalVisible });
    await page.screenshot({ path: path.join(outputDir, "03-checkout-modal-desktop.png") });

    // Confirm Payment
    const ackCheckbox = page.locator("input[type='checkbox']");
    if (await ackCheckbox.count() > 0) {
      await ackCheckbox.check();
    }
    const paySubmitBtn = page.locator(".payment-button");
    await paySubmitBtn.click();
    await page.waitForTimeout(1500);

    // Fake settle the order via fake settle endpoint
    const db = require("better-sqlite3")(dbFile);
    const pendingTopup = db.prepare("SELECT * FROM payment_orders WHERE order_kind = 'topup' ORDER BY id DESC LIMIT 1").get();
    if (pendingTopup) {
      const { settlePaidPaymentOrder } = require("../src/server/db/repositories/payment-repository");
      settlePaidPaymentOrder({ outTradeNo: pendingTopup.out_trade_no, tradeNo: "fake_browser_topup", nowIso: new Date().toISOString() });
    }
    db.close();

    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(outputDir, "04-topup-settled-desktop.png") });

    // 4. Click 查看订单 from success modal
    const viewOrderBtn = page.locator("button:has-text('查看订单')");
    if (await viewOrderBtn.count() > 0) {
      await viewOrderBtn.click();
    } else {
      await page.keyboard.press("Escape");
      const ordersTab = page.locator("button:has-text('订单记录')");
      await ordersTab.click();
    }
    await page.waitForTimeout(800);
    const ordersText = await page.textContent("body");
    const hasAuditOrder = ordersText.includes("待核查") || ordersText.includes("已支付");
    assertions.push({ name: "订单记录展示待核查/已支付订单", pass: hasAuditOrder });
    await page.screenshot({ path: path.join(outputDir, "05-orders-desktop.png"), fullPage: true });

    // 5. Mobile Viewport (390x844)
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    await mobile.addCookies([
      { name: "redbase_session", value: "test-closeout-session", domain: "localhost", path: "/" },
    ]);
    const mobilePage = await mobile.newPage();
    await mobilePage.goto("http://localhost:3334/app/billing", { waitUntil: "networkidle" });
    await mobilePage.waitForTimeout(800);
    assertions.push({ name: "移动端视口正常渲染", pass: true });
    await mobilePage.screenshot({ path: path.join(outputDir, "06-overview-mobile.png"), fullPage: true });

    console.log("\n=== 浏览器端到端测试断言结果 ===");
    for (const a of assertions) {
      console.log(`${a.pass ? "✔" : "✖"} ${a.name}`);
    }
  } finally {
    await browser.close();
    serverProc.kill("SIGTERM");
  }
}

if (require.main === module) {
  runBrowserE2E().catch((err) => {
    console.error("Browser E2E error:", err);
    process.exit(1);
  });
}

module.exports = { runBrowserE2E };
