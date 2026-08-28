const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

function toShanghaiDateString(dateOrMs) {
  const ms = typeof dateOrMs === "number" ? dateOrMs : new Date(dateOrMs).getTime();
  if (!Number.isFinite(ms)) return "";
  const shanghaiTime = new Date(ms + SHANGHAI_OFFSET_MS);
  return shanghaiTime.toISOString().slice(0, 10);
}

function shanghaiDayStartIso(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  // Date.UTC(y, m - 1, d) is 00:00:00 UTC. In UTC+8, 00:00:00 is 16:00:00 UTC previous day (minus 8 hours)
  const ms = Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS;
  return new Date(ms).toISOString();
}

function shanghaiDayEndIso(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d + 1) - SHANGHAI_OFFSET_MS;
  return new Date(ms).toISOString();
}

function parseQueryRange(query = {}) {
  const tz = String(query.timezone || "Asia/Shanghai").trim();
  if (tz !== "Asia/Shanghai") {
    const err = new Error("目前仅支持 Asia/Shanghai 时区");
    err.code = "INVALID_TIMEZONE";
    err.status = 400;
    throw err;
  }

  const nowMs = Date.now();
  const todayShanghai = toShanghaiDateString(nowMs);

  let fromIso;
  let toIso;

  if (!query.from && !query.to) {
    // Default to last 7 days (including today): [today - 6 days 00:00+08, today + 1 day 00:00+08)
    const todayStartMs = Date.parse(shanghaiDayStartIso(todayShanghai));
    const fromMs = todayStartMs - 6 * DAY_MS;
    fromIso = new Date(fromMs).toISOString();
    toIso = shanghaiDayEndIso(todayShanghai);
  } else {
    const rawFrom = String(query.from || "").trim();
    const rawTo = String(query.to || "").trim();

    if (rawFrom) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawFrom)) {
        fromIso = shanghaiDayStartIso(rawFrom);
      } else {
        const ms = Date.parse(rawFrom);
        if (!Number.isFinite(ms)) {
          const err = new Error("from 日期格式不正确");
          err.code = "INVALID_DATE";
          err.status = 400;
          throw err;
        }
        fromIso = new Date(ms).toISOString();
      }
    } else {
      const todayStartMs = Date.parse(shanghaiDayStartIso(todayShanghai));
      fromIso = new Date(todayStartMs - 6 * DAY_MS).toISOString();
    }

    if (rawTo) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawTo)) {
        // If date string given, 'to' is end of that day (exclusive boundary at next day 00:00)
        toIso = shanghaiDayEndIso(rawTo);
      } else {
        const ms = Date.parse(rawTo);
        if (!Number.isFinite(ms)) {
          const err = new Error("to 日期格式不正确");
          err.code = "INVALID_DATE";
          err.status = 400;
          throw err;
        }
        toIso = new Date(ms).toISOString();
      }
    } else {
      toIso = shanghaiDayEndIso(todayShanghai);
    }
  }

  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);

  if (fromMs >= toMs) {
    const err = new Error("起始时间必须早于结束时间");
    err.code = "INVALID_DATE_RANGE";
    err.status = 400;
    throw err;
  }

  const diffDays = Math.ceil((toMs - fromMs) / DAY_MS);
  if (diffDays > MAX_RANGE_DAYS) {
    const err = new Error(`查询时间跨度不能超过 ${MAX_RANGE_DAYS} 天`);
    err.code = "RANGE_TOO_LARGE";
    err.status = 400;
    throw err;
  }

  const durationMs = toMs - fromMs;
  const comparisonFromIso = new Date(fromMs - durationMs).toISOString();
  const comparisonToIso = fromIso;

  // Generate array of Shanghai calendar days
  const intervals = [];
  let cursorMs = fromMs;
  while (cursorMs < toMs) {
    const dayStr = toShanghaiDateString(cursorMs);
    if (!intervals.includes(dayStr)) {
      intervals.push(dayStr);
    }
    cursorMs += DAY_MS;
  }

  const accountType = query.accountType && ["customer", "yimei"].includes(String(query.accountType).trim())
    ? String(query.accountType).trim()
    : undefined;

  return {
    fromIso,
    toIso,
    timezone: tz,
    accountType,
    durationMs,
    daysCount: intervals.length,
    comparisonFromIso,
    comparisonToIso,
    intervals,
  };
}

module.exports = {
  SHANGHAI_OFFSET_MS,
  DAY_MS,
  MAX_RANGE_DAYS,
  toShanghaiDateString,
  shanghaiDayStartIso,
  shanghaiDayEndIso,
  parseQueryRange,
};
