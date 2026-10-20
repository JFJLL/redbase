"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const pwPath = "C:/Users/liuhao_PC/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright";
const { chromium } = require(pwPath);

const outputDir = path.resolve("docs/billing-v2/remediation/ui-verification");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function run() {
  console.log("=== 启动本地应用与真实浏览器截图 ===");

  // 1. Seed database
  require("./seed-ui-test-db.js");

  // 2. Start server on port 3333 with test DB and official V2 catalog (no test-10-credits override)
  const env = {
    ...process.env,
    PORT: "3333",
    NODE_ENV: "development",
    REDBASE_DB_FILE: "data/test-billing-ui.sqlite",
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
  console.log("本地应用服务已启动在 http://localhost:3333");

  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    // 1. Desktop Browser Context (1440x900)
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await desktopContext.addCookies([
      {
        name: "redbase_session",
        value: "test-session-v2",
        domain: "localhost",
        path: "/",
      },
    ]);

    const page = await desktopContext.newPage();
    await page.goto("http://localhost:3333/app/billing", { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 01. Desktop Monthly Overview (Pro active, Light downgrade/interval, Business upgrade)
    await page.screenshot({ path: path.join(outputDir, "01-overview-monthly-desktop.png"), fullPage: false });
    console.log("✔ 已截屏: 01-overview-monthly-desktop.png");

    // 02. Desktop Annual Overview
    const annualBtn = page.locator("button:has-text('年付')").first();
    if (await annualBtn.isVisible()) {
      await annualBtn.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outputDir, "02-overview-annual-desktop.png"), fullPage: false });
      console.log("✔ 已截屏: 02-overview-annual-desktop.png");
      const monthlyBtn = page.locator("button:has-text('月付')").first();
      await monthlyBtn.click();
      await page.waitForTimeout(400);
    }

    // 03. Desktop Topups Tab
    const topupTab = page.locator("button.tab:has-text('积分加油包')").first();
    if (await topupTab.isVisible()) {
      await topupTab.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outputDir, "03-topups-desktop.png"), fullPage: false });
      console.log("✔ 已截屏: 03-topups-desktop.png");
    }

    // 04. Desktop Ledger Tab
    const ledgerTab = page.locator("button.tab:has-text('积分明细')").first();
    if (await ledgerTab.isVisible()) {
      await ledgerTab.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outputDir, "04-ledger-desktop.png"), fullPage: false });
      console.log("✔ 已截屏: 04-ledger-desktop.png");
    }

    // 05. Desktop Orders Tab
    const ordersTab = page.locator("button.tab:has-text('订单记录')").first();
    if (await ordersTab.isVisible()) {
      await ordersTab.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outputDir, "05-orders-desktop.png"), fullPage: false });
      console.log("✔ 已截屏: 05-orders-desktop.png");

      // 08. Order Detail Modal
      const viewDetailBtn = page.locator("button:has-text('查看详情')").first();
      if (await viewDetailBtn.isVisible()) {
        await viewDetailBtn.click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(outputDir, "08-order-detail-desktop.png"), fullPage: false });
        console.log("✔ 已截屏: 08-order-detail-desktop.png");
        const closeBtn = page.locator(".close-button[aria-label='关闭']").first();
        if (await closeBtn.isVisible()) {
          await closeBtn.click();
        } else {
          await page.keyboard.press("Escape");
        }
        await page.waitForTimeout(400);
      }
    }

    // 07. Scheduled Modal
    const plansTab = page.locator("button.tab:has-text('周期套餐')").first();
    await plansTab.click();
    await page.waitForTimeout(600);
    const checkScheduleBtn = page.locator("button:has-text('查看安排')").first();
    if (await checkScheduleBtn.isVisible()) {
      await checkScheduleBtn.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outputDir, "07-scheduled-modal-desktop.png"), fullPage: false });
      console.log("✔ 已截屏: 07-scheduled-modal-desktop.png");
      const closeSchedBtn = page.locator(".close-button[aria-label='关闭']").first();
      if (await closeSchedBtn.isVisible()) {
        await closeSchedBtn.click();
      } else {
        await page.keyboard.press("Escape");
      }
      await page.waitForTimeout(400);
    }

    // 09. Workspace Account Modal (click avatar in sidebar)
    const userProfileBtn = page.locator(".workspace-user-profile").first();
    if (await userProfileBtn.isVisible()) {
      await userProfileBtn.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(outputDir, "09-workspace-account-modal-desktop.png"), fullPage: false });
      console.log("✔ 已截屏: 09-workspace-account-modal-desktop.png");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }

    await desktopContext.close();

    // 2. Mobile Browser Context (390x844 - iPhone 14)
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await mobileContext.addCookies([
      {
        name: "redbase_session",
        value: "test-session-v2",
        domain: "localhost",
        path: "/",
      },
    ]);

    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto("http://localhost:3333/app/billing", { waitUntil: "networkidle" });
    await mobilePage.waitForTimeout(1000);

    // 10. Mobile Overview
    await mobilePage.screenshot({ path: path.join(outputDir, "10-overview-mobile.png"), fullPage: false });
    console.log("✔ 已截屏: 10-overview-mobile.png");

    await mobileContext.close();
  } finally {
    await browser.close();
    serverProc.kill("SIGTERM");
  }

  // Part B: Clear schedule in test DB to capture Business Upgrade Checkout Dialog (06 & 11)
  const { openDatabase } = require("../src/server/db/connection");
  process.env.REDBASE_DB_FILE = "data/test-billing-ui.sqlite";
  const db = openDatabase();
  db.prepare("DELETE FROM subscription_schedules").run();

  const serverProc2 = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "3334",
      NODE_ENV: "development",
      REDBASE_DB_FILE: "data/test-billing-ui.sqlite",
      APP_CONFIG: JSON.stringify({
        alipay: { enabled: true, provider: "fake" },
        wxpay: { enabled: true, provider: "fake" },
        billing: { rechargePlans: [] },
      }),
    },
    stdio: "pipe",
    windowsHide: true,
  });

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const browser2 = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const desktopContext2 = await browser2.newContext({ viewport: { width: 1440, height: 900 } });
    await desktopContext2.addCookies([{ name: "redbase_session", value: "test-session-v2", domain: "localhost", path: "/" }]);
    const page2 = await desktopContext2.newPage();
    await page2.goto("http://localhost:3334/app/billing", { waitUntil: "networkidle" });
    await page2.waitForTimeout(1000);

    const upgradeBtn = page2.locator(".plan-card:has-text('业务版') .plan-cta").first();
    if (await upgradeBtn.isVisible()) {
      await upgradeBtn.click();
      await page2.waitForTimeout(1000);
      await page2.screenshot({ path: path.join(outputDir, "06-checkout-upgrade-desktop.png"), fullPage: false });
      console.log("✔ 已截屏: 06-checkout-upgrade-desktop.png");
    }
    await desktopContext2.close();

    const mobileContext2 = await browser2.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobileContext2.addCookies([{ name: "redbase_session", value: "test-session-v2", domain: "localhost", path: "/" }]);
    const mPage2 = await mobileContext2.newPage();
    await mPage2.goto("http://localhost:3334/app/billing", { waitUntil: "networkidle" });
    await mPage2.waitForTimeout(1000);

    const mUpgradeBtn = mPage2.locator(".plan-card:has-text('业务版') .plan-cta").first();
    if (await mUpgradeBtn.isVisible()) {
      await mUpgradeBtn.click();
      await mPage2.waitForTimeout(1000);
      await mPage2.screenshot({ path: path.join(outputDir, "11-checkout-mobile.png"), fullPage: false });
      console.log("✔ 已截屏: 11-checkout-mobile.png");
    }
    await mobileContext2.close();
  } finally {
    await browser2.close();
    serverProc2.kill("SIGTERM");
    require("./seed-ui-test-db.js");
  }

  console.log("=== 浏览器截屏全部完成并已归档至 docs/billing-v2/remediation/ui-verification ===");
}

run().catch((err) => {
  console.error("截屏过程出错:", err);
  process.exit(1);
});