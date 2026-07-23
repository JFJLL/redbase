const test = require("node:test");
const assert = require("node:assert/strict");

const {
  withExcellentRemixGroupLock,
  getExcellentRemixGroupLockSize,
  hasExcellentRemixGroupLock,
  buildExcellentRemixGroupLockKey,
  resetExcellentRemixGroupLocksForTests,
} = require("../src/server/services/excellent-remix-generation-lock");

test.beforeEach(() => {
  resetExcellentRemixGroupLocksForTests();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("same key operations run strictly FIFO serial", async () => {
  const order = [];
  const first = withExcellentRemixGroupLock(1, "group-a", async () => {
    order.push("a-start");
    await delay(40);
    order.push("a-end");
    return "a";
  });
  const second = withExcellentRemixGroupLock(1, "group-a", async () => {
    order.push("b-start");
    await delay(10);
    order.push("b-end");
    return "b";
  });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, "a");
  assert.equal(b, "b");
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  assert.equal(getExcellentRemixGroupLockSize(), 0);
});

test("different group ids for same user do not block each other", async () => {
  let aStarted = false;
  let bStarted = false;
  let bothStarted = false;

  const first = withExcellentRemixGroupLock(1, "group-a", async () => {
    aStarted = true;
    await delay(50);
    if (bStarted) bothStarted = true;
    return "a";
  });
  const second = withExcellentRemixGroupLock(1, "group-b", async () => {
    bStarted = true;
    await delay(50);
    if (aStarted) bothStarted = true;
    return "b";
  });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, "a");
  assert.equal(b, "b");
  assert.equal(bothStarted, true);
  assert.equal(getExcellentRemixGroupLockSize(), 0);
});

test("different users with same group id do not block each other", async () => {
  let user1Started = false;
  let user2Started = false;
  let bothStarted = false;

  const first = withExcellentRemixGroupLock(11, "shared-group", async () => {
    user1Started = true;
    await delay(50);
    if (user2Started) bothStarted = true;
    return 11;
  });
  const second = withExcellentRemixGroupLock(22, "shared-group", async () => {
    user2Started = true;
    await delay(50);
    if (user1Started) bothStarted = true;
    return 22;
  });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, 11);
  assert.equal(b, 22);
  assert.equal(bothStarted, true);
  assert.equal(getExcellentRemixGroupLockSize(), 0);
});

test("failed operation still releases lock for subsequent ops", async () => {
  await assert.rejects(
    () =>
      withExcellentRemixGroupLock(1, "group-fail", async () => {
        throw new Error("boom");
      }),
    /boom/,
  );

  assert.equal(hasExcellentRemixGroupLock(1, "group-fail"), false);
  assert.equal(getExcellentRemixGroupLockSize(), 0);

  const value = await withExcellentRemixGroupLock(1, "group-fail", async () => "recovered");
  assert.equal(value, "recovered");
  assert.equal(getExcellentRemixGroupLockSize(), 0);
});

test("failed operation in a concurrent chain does not block the next waiter", async () => {
  const order = [];
  const failing = withExcellentRemixGroupLock(3, "chain", async () => {
    order.push("fail-start");
    await delay(20);
    order.push("fail-throw");
    throw new Error("chain-boom");
  });
  const succeeding = withExcellentRemixGroupLock(3, "chain", async () => {
    order.push("ok-run");
    return "ok";
  });

  const [failResult, okResult] = await Promise.allSettled([failing, succeeding]);
  assert.equal(failResult.status, "rejected");
  assert.match(String(failResult.reason?.message || failResult.reason), /chain-boom/);
  assert.equal(okResult.status, "fulfilled");
  assert.equal(okResult.value, "ok");
  assert.deepEqual(order, ["fail-start", "fail-throw", "ok-run"]);
  assert.equal(getExcellentRemixGroupLockSize(), 0);
});

test("lock key normalizes user and group id", () => {
  assert.equal(
    buildExcellentRemixGroupLockKey("42", "  abc-def  "),
    buildExcellentRemixGroupLockKey(42, "abc-def"),
  );
});

test("map has no permanent residual after many serial ops", async () => {
  for (let i = 0; i < 5; i += 1) {
    await withExcellentRemixGroupLock(9, "residual", async () => i);
  }
  assert.equal(getExcellentRemixGroupLockSize(), 0);
  assert.equal(hasExcellentRemixGroupLock(9, "residual"), false);
});
