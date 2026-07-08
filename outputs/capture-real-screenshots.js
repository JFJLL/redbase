const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const out = path.resolve("outputs/poster-sources");

async function sanitize(page) {
  await page.evaluate(() => {
    const sensitiveTerms = [
      "小快克",
    ];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => {
      let text = node.nodeValue || "";
      sensitiveTerms.forEach((term) => {
        text = text.replaceAll(term, "示例品牌");
      });
      node.nodeValue = text;
    });

    const phone = document.querySelector("#userPhone");
    if (phone) phone.innerHTML = '13800000000<br><span class="credit-pill">演示积分</span>';

    const userName = document.querySelector("#userName");
    if (userName) userName.textContent = "RedBase 演示账号";

    const brandLabels = ["示例美妆品牌", "新消费品牌", "生活方式品牌"];
    const brandNodes = [
      ...document.querySelectorAll(".brand-card h3"),
      ...document.querySelectorAll(".brand-chip"),
      ...document.querySelectorAll("#historyBrandFilter option"),
    ];
    brandNodes.forEach((el, index) => {
      const text = String(el.textContent || "").trim();
      if (text && text !== "全部品牌") el.textContent = brandLabels[index % brandLabels.length];
    });
  });
}

async function capture(page, tab, file) {
  await page.click(`.sidebar-item[data-tab="${tab}"]`);
  await page.waitForTimeout(tab === "history" ? 1800 : 900);
  await sanitize(page);
  await page.screenshot({ path: path.join(out, file), fullPage: false });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on("dialog", async (dialog) => {
    console.log("dialog:", dialog.message());
    await dialog.dismiss();
  });

  await page.goto("http://127.0.0.1:3013", { waitUntil: "networkidle" });
  await page.click('[data-auth-open="login"]');
  await page.fill('#loginForm input[name="phone"]', "13800000000");
  await page.fill('#loginForm input[name="password"]', "123456");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/auth/login")).catch(() => null),
    page.click('#loginForm button[type="submit"]'),
  ]);

  await page.waitForSelector(".page-dashboard.is-active", { timeout: 15000 });
  await page.waitForTimeout(1200);

  await capture(page, "home", "redbase-home-real.png");
  await capture(page, "brands", "redbase-brands-real.png");
  await capture(page, "trends", "redbase-trends-real.png");
  await capture(page, "ideas", "redbase-ideas-real.png");
  await capture(page, "history", "redbase-history-real.png");

  await page.click("#accountCenterButton");
  await page.waitForSelector("#accountCenterModal.is-open");
  await page.waitForTimeout(500);
  await sanitize(page);
  await page.screenshot({ path: path.join(out, "redbase-account-real.png"), fullPage: false });

  await browser.close();
})();
