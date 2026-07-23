/**
 * Process-local FIFO keyed mutex for excellent-remix group generation writes.
 *
 * Same (userId, carouselGroupId) operations run strictly serially.
 * Different keys run concurrently.
 * A failed operation does not block later operations on the same key.
 * Map entries are removed when the tail of a key's chain completes.
 */

const excellentRemixGroupLocks = new Map();

function normalizeLockCarouselGroupId(carouselGroupId) {
  return String(carouselGroupId || "").trim().slice(0, 80);
}

function buildExcellentRemixGroupLockKey(userId, carouselGroupId) {
  return `${Number(userId)}:${normalizeLockCarouselGroupId(carouselGroupId)}`;
}

/**
 * @template T
 * @param {number|string} userId
 * @param {string} carouselGroupId
 * @param {() => (T|Promise<T>)} operation
 * @returns {Promise<T>}
 */
function withExcellentRemixGroupLock(userId, carouselGroupId, operation) {
  const key = buildExcellentRemixGroupLockKey(userId, carouselGroupId);
  const previous = excellentRemixGroupLocks.get(key) || Promise.resolve();

  // Run the operation after the previous tail settles (success or failure).
  const run = previous.catch(() => {}).then(() => operation());

  // Store a never-rejecting tail so the Map never retains an unhandled rejection,
  // and so later waiters can safely chain without rethrowing prior failures.
  const queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  excellentRemixGroupLocks.set(key, queueTail);

  // Cleanup only if we are still the registered tail (no newer waiter chained).
  // Compare against queueTail (what we set), not the finally-wrapped promise.
  return run.finally(() => {
    if (excellentRemixGroupLocks.get(key) === queueTail) {
      excellentRemixGroupLocks.delete(key);
    }
  });
}

function getExcellentRemixGroupLockSize() {
  return excellentRemixGroupLocks.size;
}

function hasExcellentRemixGroupLock(userId, carouselGroupId) {
  return excellentRemixGroupLocks.has(buildExcellentRemixGroupLockKey(userId, carouselGroupId));
}

/** Test-only: clear all locks. Do not call from production request paths. */
function resetExcellentRemixGroupLocksForTests() {
  excellentRemixGroupLocks.clear();
}

module.exports = {
  buildExcellentRemixGroupLockKey,
  withExcellentRemixGroupLock,
  getExcellentRemixGroupLockSize,
  hasExcellentRemixGroupLock,
  resetExcellentRemixGroupLocksForTests,
};
