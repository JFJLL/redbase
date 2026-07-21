const crypto = require("crypto");

const BASE_URL = String(process.env.SMOKE_BASE_URL || "http://127.0.0.1:3013").replace(/\/+$/, "");
const PHONE = process.env.SMOKE_PHONE || "13800000000";
const PASSWORD = process.env.SMOKE_PASSWORD || "123456";
const RUN_REAL_AI = process.env.RUN_REAL_AI === "1";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readCookie(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
  }
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function request(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function main() {
  const health = await request("/api/health");
  assert(health.response.ok, `health failed: ${health.response.status}`);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: PHONE, password: PASSWORD }),
  });
  assert(login.response.status === 200, `login failed: ${login.response.status} ${JSON.stringify(login.body)}`);
  const cookie = readCookie(login.response);
  assert(cookie.includes("redbase_session="), "login did not return a session cookie");

  const session = await request("/api/session", { cookie });
  assert(session.response.status === 200, `session failed: ${session.response.status}`);

  const brandName = `Smoke API ${Date.now()}`;
  const brand = await request("/api/brands", {
    method: "POST",
    cookie,
    body: JSON.stringify({
      name: brandName,
      industry: "Smoke Test",
      audience: "RedBase maintainers",
      description: "Disposable brand created by scripts/smoke-api.js.",
      product: "Local verification workflow",
      goal: "Confirm auth, SQL repositories, product image metadata, and optional real AI calls.",
      knowledgeBase: "This record should be deleted before the smoke script exits.",
    }),
  });
  assert(brand.response.status === 201, `brand create failed: ${brand.response.status} ${JSON.stringify(brand.body)}`);
  const brandId = brand.body.brand.id;

  const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const upload = await request("/api/product-images", {
    method: "POST",
    cookie,
    body: JSON.stringify({ name: "smoke.png", dataUrl: onePixelPng }),
  });
  assert(upload.response.status === 201, `product image upload failed: ${upload.response.status} ${JSON.stringify(upload.body)}`);
  const productImageId = upload.body.image.id;

  const productDelete = await request(`/api/product-images/${productImageId}`, { method: "DELETE", cookie });
  assert(productDelete.response.status === 200, `product image delete failed: ${productDelete.response.status}`);

  let analysisStatus = "skipped";
  if (RUN_REAL_AI) {
    const analysis = await request(`/api/brands/${brandId}/analyses`, {
      method: "POST",
      cookie,
      body: JSON.stringify({ requestId: crypto.randomUUID(), bucketKey: "traffic" }),
    });
    assert(analysis.response.status === 200, `real trend analysis failed: ${analysis.response.status} ${JSON.stringify(analysis.body)}`);
    analysisStatus = `ok:${(analysis.body.brand.trends || []).length}`;
  }

  const brandDelete = await request(`/api/brands/${brandId}`, {
    method: "DELETE",
    cookie,
    body: JSON.stringify({ deleteGenerations: true }),
  });
  assert(brandDelete.response.status === 200, `brand delete failed: ${brandDelete.response.status}`);

  console.log(JSON.stringify({
    ok: true,
    baseUrl: BASE_URL,
    userId: session.body.user?.id,
    brandId,
    productImageId,
    analysis: analysisStatus,
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
