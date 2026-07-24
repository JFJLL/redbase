const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

process.env.REDBASE_DB_FILE = ":memory:";

const { openDatabase } = require("../../src/server/db/connection");
const { initializeDatabaseSchema, ensureDatabaseIndexes } = require("../../src/server/db/schema");
const { insertUser, insertSession } = require("../../src/server/db/repositories/auth-repository");
const { insertBrand, findBrandByOwner } = require("../../src/server/db/repositories/brand-repository");
const { handlePersonalIpRoutes } = require("../../src/server/api/personal-ip-routes");

openDatabase();
initializeDatabaseSchema();
ensureDatabaseIndexes();

for (const user of [
  { id: 301, name: "IP Owner", phone: "13910000301", token: "personal-owner-token" },
  { id: 302, name: "Other Owner", phone: "13910000302", token: "personal-other-token" },
]) {
  insertUser({
    id: user.id,
    name: user.name,
    phone: user.phone,
    password: "hash",
    accountType: "customer",
    credits: 5,
    createdAt: "2026-07-23T00:00:00.000Z",
  });
  insertSession({ token: user.token, userId: user.id, createdAt: "2026-07-23T00:00:00.000Z" });
}

insertBrand({
  id: 401,
  ownerUserId: 301,
  name: "小刘成长记",
  industry: "职场成长",
  audience: "转行中的年轻人",
  description: "从运营转向产品的真实复盘",
  product: "",
  goal: "建立可信的职场成长个人 IP",
  knowledgeBase: "不虚构收入与 offer",
  assetTags: ["个人IP", "职场"],
  profileType: "personal",
  contentPillars: ["转行复盘", "效率方法"],
  personaStyle: "真诚直接，先讲过程再讲结论",
});

insertBrand({
  id: 402,
  ownerUserId: 301,
  name: "普通品牌",
  industry: "家居",
  audience: "租房人群",
  description: "用于拒绝非个人档案的测试",
  product: "折叠桌",
  goal: "品牌增长",
  assetTags: ["家居"],
});

function createReq(method, url, token, body) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = {
    host: "localhost:3013",
    cookie: token ? `redbase_session=${token}` : "",
  };
  return req;
}

function createRes() {
  return {
    statusCode: 0,
    body: null,
    writeHead(code) {
      this.statusCode = code;
    },
    end(data) {
      this.body = JSON.parse(data);
    },
  };
}

async function invoke(method, url, token, body) {
  const res = createRes();
  const pathname = new URL(url, "http://localhost:3013").pathname;
  const handled = await handlePersonalIpRoutes(
    {},
    createReq(method, url, token, body),
    res,
    pathname,
  );
  assert.equal(handled, true);
  return res;
}

test("personal material API scopes rows by owner and supports create, edit, list, delete", async () => {
  for (const invalidBrandId of ["402", "999", "not-a-number"]) {
    const invalidList = await invoke(
      "GET",
      `/api/personal-materials?brandId=${invalidBrandId}`,
      "personal-owner-token",
    );
    assert.equal(invalidList.statusCode, 400);
  }

  const rejected = await invoke("POST", "/api/personal-materials", "personal-owner-token", {
    brandId: 402,
    kind: "case",
    content: "品牌档案不能写入个人素材。",
  });
  assert.equal(rejected.statusCode, 400);

  const created = await invoke("POST", "/api/personal-materials", "personal-owner-token", {
    brandId: 401,
    kind: "case",
    title: "第一次转岗复盘",
    content: "准备三个月后完成内部转岗，过程中没有虚构结果。",
    tags: ["转行", "复盘", "转行"],
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.item.kind, "case");
  assert.deepEqual(created.body.item.tags, ["转行", "复盘"]);
  assert.equal("ownerUserId" in created.body.item, false);

  const materialId = created.body.item.id;
  const crossUserEdit = await invoke(
    "PUT",
    `/api/personal-materials/${materialId}`,
    "personal-other-token",
    { content: "越权修改" },
  );
  assert.equal(crossUserEdit.statusCode, 404);

  const updated = await invoke(
    "PUT",
    `/api/personal-materials/${materialId}`,
    "personal-owner-token",
    { kind: "viewpoint", title: "转岗方法", content: "先做岗位样例，再找真实反馈。" },
  );
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.item.kind, "viewpoint");

  const ownerList = await invoke(
    "GET",
    "/api/personal-materials?brandId=401",
    "personal-owner-token",
  );
  assert.equal(ownerList.statusCode, 200);
  assert.deepEqual(ownerList.body.items.map((item) => item.id), [materialId]);

  const otherList = await invoke("GET", "/api/personal-materials", "personal-other-token");
  assert.equal(otherList.statusCode, 200);
  assert.deepEqual(otherList.body.items, []);

  const hydrated = findBrandByOwner(401, 301);
  assert.equal(hydrated.profileType, "personal");
  assert.deepEqual(hydrated.contentPillars, ["转行复盘", "效率方法"]);
  assert.equal(hydrated.materials[0].content, "先做岗位样例，再找真实反馈。");

  const deleted = await invoke(
    "DELETE",
    `/api/personal-materials/${materialId}`,
    "personal-owner-token",
  );
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual((await invoke("GET", "/api/personal-materials", "personal-owner-token")).body.items, []);
});
