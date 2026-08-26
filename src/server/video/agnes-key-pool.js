function normalizeKeys(values = []) {
  const source = Array.isArray(values) ? values : String(values || "").split(",");
  return source.map((value) => String(value || "").trim()).filter(Boolean).filter((value, index, all) => all.indexOf(value) === index);
}

function createAgnesKeyPool({ keys = [], rpmPerKey = 1, now = () => Date.now(), cooldownMs = 60000 } = {}) {
  const slots = normalizeKeys(keys).map((key, index) => ({
    slot: index + 1,
    key,
    nextAvailableAt: 0,
    inFlight: 0,
    errorCount: 0,
    disabledUntil: 0,
    health: "healthy",
  }));
  let submissionCursor = 0;
  let pollingCursor = 0;
  const intervalMs = Math.max(1000, Math.ceil(60000 / Math.max(1, Number(rpmPerKey) || 1)));

  function publicSlot(slot) {
    const { key: _key, ...safe } = slot;
    return { ...safe };
  }

  function acquire({ rateLimit = true } = {}) {
    const timestamp = now();
    const cursor = rateLimit ? submissionCursor : pollingCursor;
    for (let offset = 0; offset < slots.length; offset += 1) {
      const index = (cursor + offset) % slots.length;
      const slot = slots[index];
      if (slot.disabledUntil > timestamp || slot.inFlight > 0 || (rateLimit && slot.nextAvailableAt > timestamp)) continue;
      slot.inFlight += 1;
      if (rateLimit) slot.nextAvailableAt = timestamp + intervalMs;
      if (rateLimit) submissionCursor = (index + 1) % slots.length;
      else pollingCursor = (index + 1) % slots.length;
      return { slot: slot.slot, key: slot.key, nextAvailableAt: slot.nextAvailableAt };
    }
    return null;
  }

  function release(slotNumber, result = {}) {
    const slot = slots.find((item) => item.slot === Number(slotNumber));
    if (!slot) return;
    slot.inFlight = Math.max(0, slot.inFlight - 1);
    if (result.rateLimited || Number(result.statusCode) === 429) {
      slot.errorCount += 1;
      slot.disabledUntil = now() + Math.max(intervalMs, Number(result.cooldownMs) || cooldownMs);
      slot.health = "cooldown";
    } else if (result.error) {
      slot.errorCount += 1;
      if (slot.errorCount >= 3) {
        slot.disabledUntil = now() + cooldownMs;
        slot.health = "degraded";
      }
    } else {
      slot.errorCount = Math.max(0, slot.errorCount - 1);
      if (slot.disabledUntil <= now()) slot.health = "healthy";
    }
  }

  return {
    hasKeys: () => slots.length > 0,
    acquire,
    release,
    getKey: (slotNumber) => slots.find((item) => item.slot === Number(slotNumber))?.key || slots[0]?.key || "",
    getAvailableKey: () => slots.find((item) => item.disabledUntil <= now())?.key || slots[0]?.key || "",
    snapshot: () => slots.map(publicSlot),
    get intervalMs() { return intervalMs; },
  };
}

module.exports = {
  normalizeKeys,
  createAgnesKeyPool,
};
