const { getDbProxy } = require("../db/connection");
const { parseQueryRange, toShanghaiDateString, DAY_MS } = require("./analytics-query-range");
const {
  ANALYTICS_FEATURE_NAMES,
  ANALYTICS_FEATURE_LABELS,
} = require("./analytics-constants");
const { getAllAnalyticsMeta, getDbStats } = require("./analytics-repository");

const db = getDbProxy();

function safeDiv(num, den) {
  const n = Number(num || 0);
  const d = Number(den || 0);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

function safePercent(num, den) {
  const res = safeDiv(num, den);
  return res == null ? null : Math.round(res * 1000) / 10;
}

function calcDeltaPercent(curr, prev) {
  const c = Number(curr || 0);
  const p = Number(prev || 0);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return Math.round(((c - p) / p) * 1000) / 10;
}

function getCoverageInfo(fromIso) {
  const meta = getAllAnalyticsMeta();
  const trackingStartedAt = meta.tracking_started_at || "";
  const clientTrackingStartedAt = meta.client_tracking_started_at || "";
  const backfillCompletedAt = meta.backfill_completed_at || "";
  const isPartial = Boolean(trackingStartedAt && fromIso < trackingStartedAt);
  const notes = [];
  if (isPartial) {
    notes.push("部分数据基于历史数据回填，用户留存与客户端步骤漏斗仅在埋点启用后完全覆盖。");
  }
  return {
    trackingStartedAt,
    clientTrackingStartedAt,
    backfillCompletedAt,
    isPartial,
    notes,
  };
}

function buildAccountFilter(accountType, alias = "e") {
  if (!accountType) return "";
  return `AND (${alias}.account_type = '${accountType}' OR ${alias}.actor_user_id IN (SELECT id FROM users WHERE account_type = '${accountType}'))`;
}

function getOverviewMetrics(query = {}) {
  const range = parseQueryRange(query);
  const { fromIso, toIso, comparisonFromIso, comparisonToIso, intervals, accountType } = range;
  const coverage = getCoverageInfo(fromIso);
  const accFilter = buildAccountFilter(accountType, "e");

  // Current period KPIs
  const currDauDays = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COUNT(DISTINCT actor_key) AS cnt
    FROM analytics_events e
    WHERE event_name = 'user_active_day'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY day
  `).all(fromIso, toIso);
  const avgDau = currDauDays.length
    ? Math.round(currDauDays.reduce((s, r) => s + r.cnt, 0) / currDauDays.length)
    : 0;

  const newUsers = db.prepare(`
    SELECT COUNT(*) AS cnt FROM analytics_events e
    WHERE event_name = 'user_registered'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  const effectiveCreators = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'output_completed'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  const payingUsers = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'payment_paid'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  const revenueFen = db.prepare(`
    SELECT COALESCE(SUM(amount_fen), 0) AS total FROM payment_orders
    WHERE status = 'paid'
      AND paid_at >= ? AND paid_at < ?
      ${accountType ? `AND user_id IN (SELECT id FROM users WHERE account_type = '${accountType}')` : ''}
  `).get(fromIso, toIso)?.total || 0;

  const outputCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM analytics_events e
    WHERE event_name = 'output_completed'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  const creditsRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN event_name = 'credit_consumed' THEN credit_cost ELSE 0 END), 0) AS gross_consumed,
      COALESCE(SUM(CASE WHEN event_name = 'credit_refunded' THEN credit_delta ELSE 0 END), 0) AS refunded
    FROM analytics_events e
    WHERE occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(fromIso, toIso);
  const grossCredits = Number(creditsRow?.gross_consumed || 0);
  const refundCredits = Number(creditsRow?.refunded || 0);
  const netCredits = grossCredits - refundCredits;

  const aiRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM ai_task_attempts
    WHERE started_at >= ? AND started_at < ?
      AND status IN ('completed', 'failed')
  `).get(fromIso, toIso);
  const aiAttemptsTotal = Number(aiRow?.total || 0);
  const aiSuccessRate = safePercent(aiRow?.completed, aiAttemptsTotal);

  // Comparison period KPIs
  const prevDauDays = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COUNT(DISTINCT actor_key) AS cnt
    FROM analytics_events e
    WHERE event_name = 'user_active_day'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY day
  `).all(comparisonFromIso, comparisonToIso);
  const prevAvgDau = prevDauDays.length
    ? Math.round(prevDauDays.reduce((s, r) => s + r.cnt, 0) / prevDauDays.length)
    : 0;

  const prevNewUsers = db.prepare(`
    SELECT COUNT(*) AS cnt FROM analytics_events e
    WHERE event_name = 'user_registered'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(comparisonFromIso, comparisonToIso)?.cnt || 0;

  const prevEffectiveCreators = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'output_completed'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(comparisonFromIso, comparisonToIso)?.cnt || 0;

  const prevPayingUsers = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'payment_paid'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(comparisonFromIso, comparisonToIso)?.cnt || 0;

  const prevRevenueFen = db.prepare(`
    SELECT COALESCE(SUM(amount_fen), 0) AS total FROM payment_orders
    WHERE status = 'paid'
      AND paid_at >= ? AND paid_at < ?
      ${accountType ? `AND user_id IN (SELECT id FROM users WHERE account_type = '${accountType}')` : ''}
  `).get(comparisonFromIso, comparisonToIso)?.total || 0;

  const prevOutputCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM analytics_events e
    WHERE event_name = 'output_completed'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(comparisonFromIso, comparisonToIso)?.cnt || 0;

  const prevCreditsRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN event_name = 'credit_consumed' THEN credit_cost ELSE 0 END), 0) AS gross_consumed,
      COALESCE(SUM(CASE WHEN event_name = 'credit_refunded' THEN credit_delta ELSE 0 END), 0) AS refunded
    FROM analytics_events e
    WHERE occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(comparisonFromIso, comparisonToIso);
  const prevNetCredits = Number(prevCreditsRow?.gross_consumed || 0) - Number(prevCreditsRow?.refunded || 0);

  const prevAiRow = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM ai_task_attempts
    WHERE started_at >= ? AND started_at < ?
      AND status IN ('completed', 'failed')
  `).get(comparisonFromIso, comparisonToIso);
  const prevAiSuccessRate = safePercent(prevAiRow?.completed, prevAiRow?.total);

  // Daily series mapping for charts
  const dayMap = (sqlRows, valKey = "val") => {
    const m = new Map();
    for (const r of sqlRows) m.set(r.day, r[valKey]);
    return intervals.map((day) => ({ date: day, value: Number(m.get(day) || 0) }));
  };

  const dauRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COUNT(DISTINCT actor_key) AS val
    FROM analytics_events e
    WHERE event_name = 'user_active_day'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY day
  `).all(fromIso, toIso);

  const newUsersRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COUNT(*) AS val
    FROM analytics_events e
    WHERE event_name = 'user_registered'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY day
  `).all(fromIso, toIso);

  const creatorsRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COUNT(DISTINCT actor_key) AS val
    FROM analytics_events e
    WHERE event_name = 'output_completed'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY day
  `).all(fromIso, toIso);

  const revenueRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(paid_at, '+8 hours')) AS day, COALESCE(SUM(amount_fen), 0) / 100.0 AS val
    FROM payment_orders
    WHERE status = 'paid'
      AND paid_at >= ? AND paid_at < ?
      ${accountType ? `AND user_id IN (SELECT id FROM users WHERE account_type = '${accountType}')` : ''}
    GROUP BY day
  `).all(fromIso, toIso);

  const outputRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COUNT(*) AS val
    FROM analytics_events e
    WHERE event_name = 'output_completed'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY day
  `).all(fromIso, toIso);

  // Feature usage distribution
  const featureDistribution = db.prepare(`
    SELECT feature, COUNT(*) AS count, COUNT(DISTINCT actor_key) AS users_count
    FROM analytics_events e
    WHERE event_name = 'output_completed'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY feature
  `).all(fromIso, toIso).map((r) => ({
    feature: r.feature,
    label: ANALYTICS_FEATURE_LABELS[r.feature] || r.feature,
    count: Number(r.count || 0),
    usersCount: Number(r.users_count || 0),
  }));

  return {
    generatedAt: new Date().toISOString(),
    range: { from: fromIso, to: toIso, timezone: range.timezone, accountType },
    comparisonRange: { from: comparisonFromIso, to: comparisonToIso },
    coverage,
    kpis: {
      dau: { value: avgDau, prevValue: prevAvgDau, deltaPercent: calcDeltaPercent(avgDau, prevAvgDau), sampleSize: currDauDays.length },
      newUsers: { value: newUsers, prevValue: prevNewUsers, deltaPercent: calcDeltaPercent(newUsers, prevNewUsers) },
      effectiveCreators: { value: effectiveCreators, prevValue: prevEffectiveCreators, deltaPercent: calcDeltaPercent(effectiveCreators, prevEffectiveCreators) },
      payingUsers: { value: payingUsers, prevValue: prevPayingUsers, deltaPercent: calcDeltaPercent(payingUsers, prevPayingUsers) },
      revenueYuan: { value: revenueFen / 100, prevValue: prevRevenueFen / 100, deltaPercent: calcDeltaPercent(revenueFen, prevRevenueFen) },
      outputs: { value: outputCount, prevValue: prevOutputCount, deltaPercent: calcDeltaPercent(outputCount, prevOutputCount) },
      netCredits: { value: netCredits, prevValue: prevNetCredits, deltaPercent: calcDeltaPercent(netCredits, prevNetCredits) },
      aiSuccessRate: { value: aiSuccessRate, prevValue: prevAiSuccessRate, deltaPercent: calcDeltaPercent(aiSuccessRate, prevAiSuccessRate), sampleSize: aiAttemptsTotal },
    },
    trends: {
      dauSeries: dayMap(dauRows),
      newUsersSeries: dayMap(newUsersRows),
      creatorsSeries: dayMap(creatorsRows),
      revenueSeries: dayMap(revenueRows),
      outputsSeries: dayMap(outputRows),
    },
    featureDistribution,
  };
}

function getUsersMetrics(query = {}) {
  const range = parseQueryRange(query);
  const { fromIso, toIso, intervals, accountType } = range;
  const coverage = getCoverageInfo(fromIso);
  const accFilter = buildAccountFilter(accountType, "e");

  // DAU / WAU / MAU
  const nowMs = Date.now();
  const todayShanghai = toShanghaiDateString(nowMs);
  const last7dStart = new Date(nowMs - 7 * DAY_MS).toISOString();
  const last30dStart = new Date(nowMs - 30 * DAY_MS).toISOString();

  const todayDau = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'user_active_day'
      AND strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) = ?
      ${accFilter}
  `).get(todayShanghai)?.cnt || 0;

  const wau = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'user_active_day'
      AND occurred_at >= ?
      ${accFilter}
  `).get(last7dStart)?.cnt || 0;

  const mau = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'user_active_day'
      AND occurred_at >= ?
      ${accFilter}
  `).get(last30dStart)?.cnt || 0;

  // Main conversion funnel
  // 1. 注册
  const step1 = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'user_registered' AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  // 2. 创建品牌
  const step2 = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'brand_created' AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  // 3. 趋势/方向
  const step3 = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE (event_name LIKE 'trend_analysis%' OR event_name LIKE 'excellent_direction%')
      AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  // 4. 首次内容生成
  const step4 = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'output_completed' AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  // 5. 第二次内容生成
  const step5 = db.prepare(`
    SELECT COUNT(*) AS cnt FROM (
      SELECT actor_key FROM analytics_events e
      WHERE event_name = 'output_completed' AND occurred_at >= ? AND occurred_at < ? ${accFilter}
      GROUP BY actor_key HAVING COUNT(*) >= 2
    )
  `).get(fromIso, toIso)?.cnt || 0;

  // 6. 进入充值页
  const step6 = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE (event_name = 'recharge_page_viewed' OR event_name = 'payment_order_created' OR event_name = 'payment_paid')
      AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  // 7. 创建支付订单
  const step7 = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'payment_order_created' AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  // 8. 支付成功
  const step8 = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'payment_paid' AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  const mainFunnel = [
    { step: "注册用户", count: step1, rate: step1 > 0 ? 100 : 0 },
    { step: "创建品牌", count: step2, rate: safePercent(step2, step1) },
    { step: "探索热点/方向", count: step3, rate: safePercent(step3, step1) },
    { step: "首次内容生成", count: step4, rate: safePercent(step4, step1) },
    { step: "二次复购创作", count: step5, rate: safePercent(step5, step1) },
    { step: "进入充值环节", count: step6, rate: safePercent(step6, step1) },
    { step: "创建支付订单", count: step7, rate: safePercent(step7, step1) },
    { step: "支付成功", count: step8, rate: safePercent(step8, step1) },
  ];

  // Video production funnel
  const vScript = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'video_script_completed' AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  const vCreated = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'video_project_created' AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  const vCompleted = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'video_project_completed' AND occurred_at >= ? AND occurred_at < ? ${accFilter}
  `).get(fromIso, toIso)?.cnt || 0;

  const videoFunnel = [
    { step: "视频分镜脚本生成", count: vScript, rate: vScript > 0 ? 100 : 0 },
    { step: "发起视频项目制作", count: vCreated, rate: safePercent(vCreated, vScript) },
    { step: "最终视频成片完成", count: vCompleted, rate: safePercent(vCompleted, vScript) },
  ];

  // Retention (D1, D7, D30) for cohorts in range
  const cohorts = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', datetime(u.occurred_at, '+8 hours')) AS reg_day,
      u.actor_key,
      u.occurred_at AS reg_at
    FROM analytics_events u
    WHERE u.event_name = 'user_registered'
      AND u.occurred_at >= ? AND u.occurred_at < ?
      ${accFilter}
  `).all(fromIso, toIso);

  let cohortTotal = cohorts.length;
  let d1Retained = 0;
  let d7Retained = 0;
  let d30Retained = 0;

  for (const c of cohorts) {
    const regMs = Date.parse(c.reg_at);
    const d1Start = new Date(regMs + 1 * DAY_MS).toISOString();
    const d1End = new Date(regMs + 2 * DAY_MS).toISOString();
    const d7Start = new Date(regMs + 7 * DAY_MS).toISOString();
    const d7End = new Date(regMs + 8 * DAY_MS).toISOString();
    const d30Start = new Date(regMs + 30 * DAY_MS).toISOString();
    const d30End = new Date(regMs + 31 * DAY_MS).toISOString();

    const actD1 = db.prepare("SELECT 1 FROM analytics_events WHERE actor_key = ? AND event_name = 'user_active_day' AND occurred_at >= ? AND occurred_at < ? LIMIT 1").get(c.actor_key, d1Start, d1End);
    if (actD1) d1Retained++;

    const actD7 = db.prepare("SELECT 1 FROM analytics_events WHERE actor_key = ? AND event_name = 'user_active_day' AND occurred_at >= ? AND occurred_at < ? LIMIT 1").get(c.actor_key, d7Start, d7End);
    if (actD7) d7Retained++;

    const actD30 = db.prepare("SELECT 1 FROM analytics_events WHERE actor_key = ? AND event_name = 'user_active_day' AND occurred_at >= ? AND occurred_at < ? LIMIT 1").get(c.actor_key, d30Start, d30End);
    if (actD30) d30Retained++;
  }

  const retention = {
    cohortSize: cohortTotal,
    d1Rate: safePercent(d1Retained, cohortTotal),
    d7Rate: safePercent(d7Retained, cohortTotal),
    d30Rate: safePercent(d30Retained, cohortTotal),
  };

  // Account type distribution
  const accountDistribution = db.prepare(`
    SELECT account_type, COUNT(*) AS count
    FROM users
    GROUP BY account_type
  `).all().map((r) => ({
    accountType: r.account_type,
    label: r.account_type === "yimei" ? "易美内部账号" : "客户账号",
    count: Number(r.count || 0),
  }));

  return {
    generatedAt: new Date().toISOString(),
    range: { from: fromIso, to: toIso, timezone: range.timezone, accountType },
    coverage,
    activity: { todayDau, wau, mau },
    mainFunnel,
    videoFunnel,
    retention,
    accountDistribution,
  };
}

function getFeaturesMetrics(query = {}) {
  const range = parseQueryRange(query);
  const { fromIso, toIso, intervals, accountType } = range;
  const coverage = getCoverageInfo(fromIso);
  const accFilter = buildAccountFilter(accountType, "e");

  const featureStats = ANALYTICS_FEATURE_NAMES.map((feat) => {
    const label = ANALYTICS_FEATURE_LABELS[feat] || feat;

    const statsRow = db.prepare(`
      SELECT
        COUNT(DISTINCT actor_key) AS users_count,
        COUNT(*) AS requests_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failure_count,
        SUM(CASE WHEN credit_cost > 0 THEN credit_cost ELSE 0 END) AS gross_credits
      FROM analytics_events e
      WHERE feature = ?
        AND occurred_at >= ? AND occurred_at < ?
        ${accFilter}
    `).get(feat, fromIso, toIso);

    const usersCount = Number(statsRow?.users_count || 0);
    const requestsCount = Number(statsRow?.requests_count || 0);
    const successCount = Number(statsRow?.success_count || 0);
    const failureCount = Number(statsRow?.failure_count || 0);
    const grossCredits = Number(statsRow?.gross_credits || 0);

    // Refunds for this feature
    const refundRow = db.prepare(`
      SELECT COALESCE(SUM(credit_delta), 0) AS total_refund
      FROM credit_events
      WHERE credit_delta > 0
        AND action_type LIKE ?
        AND created_at >= ? AND created_at < ?
        ${accountType ? `AND user_id IN (SELECT id FROM users WHERE account_type = '${accountType}')` : ''}
    `).get(`%${feat}%`, fromIso, toIso);
    const refundCredits = Number(refundRow?.total_refund || 0);
    const netCredits = grossCredits - refundCredits;

    // Daily trend
    const dailyRows = db.prepare(`
      SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COUNT(*) AS val
      FROM analytics_events e
      WHERE feature = ?
        AND occurred_at >= ? AND occurred_at < ?
        ${accFilter}
      GROUP BY day
    `).all(feat, fromIso, toIso);
    const dayMap = new Map(dailyRows.map((r) => [r.day, r.val]));
    const trend = intervals.map((d) => ({ date: d, value: Number(dayMap.get(d) || 0) }));

    return {
      feature: feat,
      label,
      usersCount,
      requestsCount,
      successCount,
      failureCount,
      successRate: safePercent(successCount, successCount + failureCount),
      grossCredits,
      refundCredits,
      netCredits,
      avgRequestsPerUser: usersCount > 0 ? Math.round((requestsCount / usersCount) * 10) / 10 : 0,
      trend,
    };
  });

  // Top failure reasons across features
  const failureReasons = db.prepare(`
    SELECT error_stage, error_code, COUNT(*) AS count
    FROM ai_task_attempts
    WHERE status = 'failed'
      AND started_at >= ? AND started_at < ?
    GROUP BY error_stage, error_code
    ORDER BY count DESC
    LIMIT 10
  `).all(fromIso, toIso).map((r) => ({
    stage: r.error_stage || "unknown",
    code: r.error_code || "UNKNOWN",
    count: Number(r.count || 0),
  }));

  return {
    generatedAt: new Date().toISOString(),
    range: { from: fromIso, to: toIso, timezone: range.timezone, accountType },
    coverage,
    features: featureStats,
    failureReasons,
  };
}

function getAiMetrics(query = {}) {
  const range = parseQueryRange(query);
  const { fromIso, toIso } = range;
  const coverage = getCoverageInfo(fromIso);

  // Summary across all AI attempts
  const summaryRow = db.prepare(`
    SELECT
      COUNT(*) AS total_requests,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN attempt_kind IN ('auto_retry', 'manual_retry', 'result_retry', 'assembly_retry') THEN 1 ELSE 0 END) AS retry_count,
      AVG(CASE WHEN duration_ms > 0 THEN duration_ms ELSE NULL END) AS avg_duration
    FROM ai_task_attempts
    WHERE started_at >= ? AND started_at < ?
  `).get(fromIso, toIso);

  const totalRequests = Number(summaryRow?.total_requests || 0);
  const completedCount = Number(summaryRow?.completed_count || 0);
  const failedCount = Number(summaryRow?.failed_count || 0);
  const retryCount = Number(summaryRow?.retry_count || 0);
  const successRate = safePercent(completedCount, completedCount + failedCount);
  const retryRate = safePercent(retryCount, totalRequests);

  // Latency percentiles
  const durations = db.prepare(`
    SELECT duration_ms FROM ai_task_attempts
    WHERE started_at >= ? AND started_at < ? AND duration_ms > 0
    ORDER BY duration_ms ASC
  `).all(fromIso, toIso).map((r) => r.duration_ms);

  let p50LatencyMs = null;
  let p95LatencyMs = null;
  if (durations.length > 0) {
    const p50Idx = Math.floor(durations.length * 0.5);
    const p95Idx = Math.floor(durations.length * 0.95);
    p50LatencyMs = durations[p50Idx];
    p95LatencyMs = durations[Math.min(p95Idx, durations.length - 1)];
  }

  // Table by Feature / Provider / Model
  const breakdownRows = db.prepare(`
    SELECT
      feature, provider, model,
      COUNT(*) AS total_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS success_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS fail_count,
      AVG(CASE WHEN duration_ms > 0 THEN duration_ms ELSE NULL END) AS avg_ms,
      SUM(COALESCE(total_tokens, 0)) AS total_tokens,
      SUM(CASE WHEN attempt_kind IN ('auto_retry', 'manual_retry') THEN 1 ELSE 0 END) AS retry_count
    FROM ai_task_attempts
    WHERE started_at >= ? AND started_at < ?
    GROUP BY feature, provider, model
    ORDER BY total_count DESC
  `).all(fromIso, toIso).map((r) => ({
    feature: r.feature,
    featureLabel: ANALYTICS_FEATURE_LABELS[r.feature] || r.feature,
    provider: r.provider || "default",
    model: r.model || "default",
    requestsCount: Number(r.total_count || 0),
    successRate: safePercent(r.success_count, Number(r.success_count || 0) + Number(r.fail_count || 0)),
    avgDurationMs: Math.round(Number(r.avg_ms || 0)),
    tokensTotal: Number(r.total_tokens || 0),
    retryCount: Number(r.retry_count || 0),
  }));

  // Error stages
  const errorStages = db.prepare(`
    SELECT error_stage, COUNT(*) AS count
    FROM ai_task_attempts
    WHERE status = 'failed' AND started_at >= ? AND started_at < ?
    GROUP BY error_stage
    ORDER BY count DESC
  `).all(fromIso, toIso).map((r) => ({
    stage: r.error_stage || "unknown",
    count: Number(r.count || 0),
    percent: safePercent(r.count, failedCount),
  }));

  // Top error codes
  const topErrorCodes = db.prepare(`
    SELECT error_code, error_stage, COUNT(*) AS count, MAX(error_message) AS sample_message
    FROM ai_task_attempts
    WHERE status = 'failed' AND started_at >= ? AND started_at < ?
    GROUP BY error_code, error_stage
    ORDER BY count DESC
    LIMIT 10
  `).all(fromIso, toIso).map((r) => ({
    code: r.error_code || "UNKNOWN",
    stage: r.error_stage || "unknown",
    count: Number(r.count || 0),
    sampleMessage: r.sample_message || "",
  }));

  // Video D2 vs G2 comparison
  const videoComparison = db.prepare(`
    SELECT
      video_model AS model,
      mode,
      resolution,
      aspect_ratio,
      total_duration_sec,
      COUNT(*) AS project_count,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status IN ('failed', 'project_data_failed', 'result_processing_failed', 'partial_failed', 'uncertain', 'assembly_failed') THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN charged_credits > 0 THEN charged_credits ELSE 0 END) AS gross_credits,
      SUM(CASE WHEN refunded_credits > 0 THEN refunded_credits ELSE 0 END) AS refund_credits
    FROM video_projects
    WHERE created_at >= ? AND created_at < ?
    GROUP BY video_model, mode, resolution, aspect_ratio, total_duration_sec
  `).all(fromIso, toIso).map((r) => {
    const matureProjects = Number(r.completed_count || 0) + Number(r.failed_count || 0);
    const netCredits = Number(r.gross_credits || 0) - Number(r.refund_credits || 0);
    const totalSuccessSec = Number(r.completed_count || 0) * Number(r.total_duration_sec || 0);
    return {
      model: r.model,
      mode: r.mode,
      resolution: r.resolution,
      aspectRatio: r.aspect_ratio,
      totalDurationSec: r.total_duration_sec,
      projectCount: Number(r.project_count || 0),
      completionRate: safePercent(r.completed_count, matureProjects),
      avgNetCredits: r.project_count > 0 ? Math.round(netCredits / r.project_count) : 0,
      netCreditsPerSuccessSecond: totalSuccessSec > 0 ? Math.round((netCredits / totalSuccessSec) * 10) / 10 : 0,
      vendorCost: null, // "未配置"
      vendorCostLabel: "未配置",
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    range: { from: fromIso, to: toIso, timezone: range.timezone },
    coverage,
    summary: {
      totalRequests,
      completedCount,
      failedCount,
      successRate,
      retryRate,
      p50LatencyMs,
      p95LatencyMs,
    },
    breakdown: breakdownRows,
    errorStages,
    topErrorCodes,
    videoComparison,
  };
}

function getFinanceMetrics(query = {}) {
  const range = parseQueryRange(query);
  const { fromIso, toIso, intervals, accountType } = range;
  const coverage = getCoverageInfo(fromIso);
  const accClause = accountType ? `AND user_id IN (SELECT id FROM users WHERE account_type = '${accountType}')` : "";

  // Total Revenue & Orders
  const ordersRow = db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
      SUM(CASE WHEN status = 'paid' THEN amount_fen ELSE 0 END) AS paid_amount_fen,
      COUNT(DISTINCT CASE WHEN status = 'paid' THEN user_id ELSE NULL END) AS paying_users
    FROM payment_orders
    WHERE created_at >= ? AND created_at < ?
      ${accClause}
  `).get(fromIso, toIso);

  const totalOrders = Number(ordersRow?.total_orders || 0);
  const paidOrders = Number(ordersRow?.paid_orders || 0);
  const paidAmountFen = Number(ordersRow?.paid_amount_fen || 0);
  const payingUsers = Number(ordersRow?.paying_users || 0);
  const revenueYuan = paidAmountFen / 100;
  const arppu = payingUsers > 0 ? Math.round((revenueYuan / payingUsers) * 10) / 10 : 0;
  const conversionRate = safePercent(paidOrders, totalOrders);

  // Channel comparison: Alipay vs WeChat
  const channelComparison = db.prepare(`
    SELECT
      provider,
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_orders,
      SUM(CASE WHEN status = 'paid' THEN amount_fen ELSE 0 END) / 100.0 AS revenue_yuan
    FROM payment_orders
    WHERE created_at >= ? AND created_at < ?
      ${accClause}
    GROUP BY provider
  `).all(fromIso, toIso).map((r) => ({
    provider: r.provider,
    providerLabel: r.provider === "wxpay" ? "微信支付" : "支付宝",
    totalOrders: Number(r.total_orders || 0),
    paidOrders: Number(r.paid_orders || 0),
    revenueYuan: Number(r.revenue_yuan || 0),
  }));

  // Plan package distribution
  const planDistribution = db.prepare(`
    SELECT
      plan_id, plan_name,
      COUNT(*) AS orders_count,
      SUM(CASE WHEN status = 'paid' THEN amount_fen ELSE 0 END) / 100.0 AS revenue_yuan
    FROM payment_orders
    WHERE status = 'paid' AND created_at >= ? AND created_at < ?
      ${accClause}
    GROUP BY plan_id, plan_name
    ORDER BY revenue_yuan DESC
  `).all(fromIso, toIso).map((r) => ({
    planId: r.plan_id,
    planName: r.plan_name || r.plan_id,
    ordersCount: Number(r.orders_count || 0),
    revenueYuan: Number(r.revenue_yuan || 0),
  }));

  // Daily revenue trend
  const revDailyRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(paid_at, '+8 hours')) AS day, SUM(amount_fen) / 100.0 AS val
    FROM payment_orders
    WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?
      ${accClause}
    GROUP BY day
  `).all(fromIso, toIso);
  const revMap = new Map(revDailyRows.map((r) => [r.day, r.val]));
  const revenueSeries = intervals.map((d) => ({ date: d, value: Number(revMap.get(d) || 0) }));

  // Credits pool and trends
  const currentRemainingCredits = db.prepare(`
    SELECT COALESCE(SUM(credits), 0) AS total FROM users
    ${accountType ? `WHERE account_type = '${accountType}'` : ''}
  `).get()?.total || 0;

  const adminGrantedCredits = db.prepare(`
    SELECT COALESCE(SUM(credit_delta), 0) AS total FROM credit_events
    WHERE action_type = 'adminAddCredits'
      AND created_at >= ? AND created_at < ?
      ${accountType ? `AND user_id IN (SELECT id FROM users WHERE account_type = '${accountType}')` : ''}
  `).get(fromIso, toIso)?.total || 0;

  const auditIssuesCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM payment_orders
    WHERE audit_reason != ''
  `).get()?.cnt || 0;

  return {
    generatedAt: new Date().toISOString(),
    range: { from: fromIso, to: toIso, timezone: range.timezone, accountType },
    coverage,
    overview: {
      revenueYuan,
      payingUsers,
      arppu,
      totalOrders,
      paidOrders,
      conversionRate,
      currentRemainingCredits: Number(currentRemainingCredits),
      adminGrantedCredits: Number(adminGrantedCredits),
      auditIssuesCount: Number(auditIssuesCount),
    },
    channelComparison,
    planDistribution,
    revenueSeries,
  };
}

function getSystemMetrics(query = {}, { videoProjectService } = {}) {
  const dbStats = getDbStats();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const last24hIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const tenMinutesAgoMs = nowMs - 10 * 60 * 1000;

  // Image tasks
  const imagePending = db.prepare("SELECT COUNT(*) AS cnt FROM image_jobs WHERE status = 'pending'").get()?.cnt || 0;
  const imageRunning = db.prepare("SELECT COUNT(*) AS cnt FROM image_jobs WHERE status = 'running'").get()?.cnt || 0;
  const imageFailedLast24h = db.prepare("SELECT COUNT(*) AS cnt FROM image_jobs WHERE status = 'failed' AND created_at_ms >= ?").get(Date.now() - 24 * 60 * 60 * 1000)?.cnt || 0;

  const oldestActiveJob = db.prepare("SELECT created_at_ms FROM image_jobs WHERE status IN ('pending', 'running') ORDER BY created_at_ms ASC LIMIT 1").get();
  const imageOldestActiveAgeSec = oldestActiveJob?.created_at_ms ? Math.max(0, Math.floor((nowMs - oldestActiveJob.created_at_ms) / 1000)) : 0;
  const imageStuckCount = db.prepare("SELECT COUNT(*) AS cnt FROM image_jobs WHERE status IN ('pending', 'running') AND created_at_ms <= ?").get(tenMinutesAgoMs)?.cnt || 0;

  // Video runtime health
  const videoRuntime = videoProjectService && typeof videoProjectService.getRuntimeHealth === "function"
    ? videoProjectService.getRuntimeHealth()
    : {
        schedulerRunning: true,
        activeProjectCount: 0,
        queueDepthByStatus: {},
        oldestQueuedAgeSec: 0,
        oldestActiveAgeSec: 0,
        stuckCount: 0,
        d2Submission: { active: 0, limit: 4 },
        mediaProcessing: { active: 0, limit: 3 },
        ffmpeg: { active: 0, limit: 1 },
        agnes: { keyTotal: 0, healthy: 0, cooldown: 0, degraded: 0, inFlight: 0 },
        actionable: { waitingConfiguration: 0, resultProcessingFailed: 0, partialFailed: 0, uncertain: 0, assemblyFailed: 0 },
      };

  // Payment
  const paymentAuditCount = db.prepare("SELECT COUNT(*) AS cnt FROM payment_orders WHERE audit_reason != ''").get()?.cnt || 0;
  const paymentPendingExpiredCount = db.prepare("SELECT COUNT(*) AS cnt FROM payment_orders WHERE status IN ('created', 'pending') AND expires_at < ?").get(nowIso)?.cnt || 0;
  const paymentFailedLast24h = db.prepare("SELECT COUNT(*) AS cnt FROM payment_orders WHERE status = 'failed' AND created_at >= ?").get(last24hIso)?.cnt || 0;

  // Asset purge stats
  const purgeStats = db.prepare(`
    SELECT
      COUNT(CASE WHEN asset_status = 'purged' THEN 1 ELSE NULL END) AS purged_generation_count,
      COALESCE(SUM(CASE WHEN asset_status = 'purged' THEN asset_count ELSE 0 END), 0) AS purged_asset_count,
      COALESCE(SUM(CASE WHEN asset_status = 'purged' THEN asset_bytes ELSE 0 END), 0) AS purged_bytes,
      COUNT(CASE WHEN asset_status = 'purge_failed' THEN 1 ELSE NULL END) AS purge_failed_count,
      MAX(assets_deleted_at) AS last_purge_at
    FROM generations
  `).get();

  // AI 24h metrics
  const ai24h = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM ai_task_attempts
    WHERE started_at >= ?
  `).get(last24hIso);
  const aiErrorsLast24h = Number(ai24h?.failed || 0);
  const aiSuccessRateLast24h = safePercent(ai24h?.completed, Number(ai24h?.completed || 0) + Number(ai24h?.failed || 0));

  const lat24h = db.prepare(`
    SELECT duration_ms FROM ai_task_attempts
    WHERE started_at >= ? AND duration_ms > 0
    ORDER BY duration_ms ASC
  `).all(last24hIso).map((r) => r.duration_ms);
  let p95LatencyLast24h = null;
  if (lat24h.length > 0) {
    const idx = Math.floor(lat24h.length * 0.95);
    p95LatencyLast24h = lat24h[Math.min(idx, lat24h.length - 1)];
  }

  // Centralized alert rules
  const alerts = [];
  if (imageStuckCount > 0) {
    alerts.push({ level: "warning", message: `当前有 ${imageStuckCount} 个图片生成任务活跃超过 10 分钟，疑似卡住。` });
  }
  if (videoRuntime.stuckCount > 0) {
    alerts.push({ level: "warning", message: `当前有 ${videoRuntime.stuckCount} 个视频项目活跃超过 2 小时，疑似卡住。` });
  }
  if (videoRuntime.actionable?.waitingConfiguration > 0) {
    alerts.push({ level: "warning", message: `当前有 ${videoRuntime.actionable.waitingConfiguration} 个视频任务因配置缺失阻塞。` });
  }
  if (paymentAuditCount > 0) {
    alerts.push({ level: "warning", message: `发现 ${paymentAuditCount} 笔支付审计异常订单，请尽快核对。` });
  }
  if (Number(purgeStats?.purge_failed_count || 0) > 0) {
    alerts.push({ level: "warning", message: `有 ${purgeStats.purge_failed_count} 条生成记录媒体清理失败，等待下一次重试。` });
  }
  if (aiSuccessRateLast24h !== null && aiSuccessRateLast24h < 90 && Number(ai24h?.total || 0) >= 20) {
    alerts.push({ level: "warning", message: `近24小时 AI 整体成功率低于 90%（当前 ${aiSuccessRateLast24h}%）。` });
  }

  return {
    generatedAt: nowIso,
    database: dbStats,
    imageJobs: {
      pending: imagePending,
      running: imageRunning,
      failedLast24h: imageFailedLast24h,
      oldestActiveAgeSec: imageOldestActiveAgeSec,
      stuckCount: imageStuckCount,
    },
    videoJobs: videoRuntime,
    payment: {
      auditCount: paymentAuditCount,
      pendingExpiredCount: paymentPendingExpiredCount,
      failedLast24h: paymentFailedLast24h,
    },
    assetPurge: {
      purgedGenerationCount: Number(purgeStats?.purged_generation_count || 0),
      purgedAssetCount: Number(purgeStats?.purged_asset_count || 0),
      purgedBytes: Number(purgeStats?.purged_bytes || 0),
      purgeFailedCount: Number(purgeStats?.purge_failed_count || 0),
      lastPurgeAt: purgeStats?.last_purge_at || "",
    },
    ai: {
      errorsLast24h: aiErrorsLast24h,
      successRateLast24h: aiSuccessRateLast24h,
      p95LatencyLast24h,
    },
    alerts,
  };
}

module.exports = {
  getOverviewMetrics,
  getUsersMetrics,
  getFeaturesMetrics,
  getAiMetrics,
  getFinanceMetrics,
  getSystemMetrics,
};
