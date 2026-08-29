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

function percentile(values, ratio) {
  const sorted = values.map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function getCoverageInfo(fromIso) {
  const meta = getAllAnalyticsMeta();
  const trackingStartedAt = meta.tracking_started_at || "";
  const clientTrackingStartedAt = meta.client_tracking_started_at || "";
  const backfillCompletedAt = meta.backfill_completed_at || "";
  const backfillFailed = meta.backfill_status === "failed";
  const isPartial = backfillFailed || Boolean(trackingStartedAt && fromIso < trackingStartedAt);
  const notes = [];
  if (backfillFailed) {
    notes.push(`历史回填部分覆盖：${meta.backfill_error || "启动回填失败，请检查服务日志。"}`);
  }
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
  if (accountType === "customer") return `AND ${alias}.is_admin = 0 AND ${alias}.account_type = 'customer'`;
  if (accountType === "yimei") return `AND ${alias}.is_admin = 0 AND ${alias}.account_type = 'yimei'`;
  return `AND ${alias}.is_admin = 0`;
}

function getOverviewMetrics(query = {}) {
  const range = parseQueryRange(query);
  const { fromIso, toIso, comparisonFromIso, comparisonToIso, intervals, daysCount, accountType } = range;
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
  const avgDau = daysCount
    ? Math.round(currDauDays.reduce((s, r) => s + Number(r.cnt || 0), 0) / daysCount)
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
    SELECT COALESCE(SUM(amount_fen), 0) AS total FROM analytics_events e
    WHERE event_name = 'payment_paid'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
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
    FROM ai_task_attempts a
    WHERE started_at >= ? AND started_at < ?
      AND status IN ('completed', 'failed')
      AND task_type IN ('text_generation', 'image_generation', 'video_clip_generation')
      ${buildAccountFilter(accountType, "a")}
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
  const prevAvgDau = daysCount
    ? Math.round(prevDauDays.reduce((s, r) => s + Number(r.cnt || 0), 0) / daysCount)
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
    SELECT COALESCE(SUM(amount_fen), 0) AS total FROM analytics_events e
    WHERE event_name = 'payment_paid'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
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
    FROM ai_task_attempts a
    WHERE started_at >= ? AND started_at < ?
      AND status IN ('completed', 'failed')
      AND task_type IN ('text_generation', 'image_generation', 'video_clip_generation')
      ${buildAccountFilter(accountType, "a")}
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
    SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COALESCE(SUM(amount_fen), 0) / 100.0 AS val
    FROM analytics_events e
    WHERE event_name = 'payment_paid'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
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
      dau: { value: avgDau, prevValue: prevAvgDau, deltaPercent: calcDeltaPercent(avgDau, prevAvgDau), sampleSize: daysCount },
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
  const anchorExclusiveMs = Date.parse(toIso);
  const anchorInclusiveMs = anchorExclusiveMs - 1;
  const todayShanghai = toShanghaiDateString(anchorInclusiveMs);
  const last7dStart = new Date(anchorExclusiveMs - 7 * DAY_MS).toISOString();
  const last30dStart = new Date(anchorExclusiveMs - 30 * DAY_MS).toISOString();

  const todayDau = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'user_active_day'
      AND strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) = ?
      ${accFilter}
  `).get(todayShanghai)?.cnt || 0;

  const wau = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'user_active_day'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(last7dStart, toIso)?.cnt || 0;

  const mau = db.prepare(`
    SELECT COUNT(DISTINCT actor_key) AS cnt FROM analytics_events e
    WHERE event_name = 'user_active_day'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(last30dStart, toIso)?.cnt || 0;

  // Main conversion funnel (strictly sequential cohort-based)
  const funnelRow = db.prepare(`
    WITH reg_cohort AS (
      SELECT DISTINCT actor_key, occurred_at AS reg_at
      FROM analytics_events e
      WHERE event_name = 'user_registered'
        AND occurred_at >= ? AND occurred_at < ?
        ${accFilter}
    ),
    s2_brand AS (
      SELECT rc.actor_key, MIN(e.occurred_at) AS brand_at
      FROM reg_cohort rc
      JOIN analytics_events e ON e.actor_key = rc.actor_key
      WHERE e.event_name = 'brand_created'
        AND e.occurred_at >= rc.reg_at
        ${accFilter}
      GROUP BY rc.actor_key
    ),
    s3_trend AS (
      SELECT s2.actor_key, MIN(e.occurred_at) AS trend_at
      FROM s2_brand s2
      JOIN analytics_events e ON e.actor_key = s2.actor_key
      WHERE e.event_name IN ('trend_analysis_completed', 'excellent_direction_completed')
        AND e.occurred_at >= s2.brand_at
        ${accFilter}
      GROUP BY s2.actor_key
    ),
    s4_first_output AS (
      SELECT s3.actor_key, MIN(e.occurred_at) AS output1_at
      FROM s3_trend s3
      JOIN analytics_events e ON e.actor_key = s3.actor_key
      WHERE e.event_name = 'output_completed'
        AND e.occurred_at >= s3.trend_at
        ${accFilter}
      GROUP BY s3.actor_key
    ),
    s5_second_output AS (
      SELECT s4.actor_key, MIN(e.occurred_at) AS output2_at
      FROM s4_first_output s4
      JOIN analytics_events e ON e.actor_key = s4.actor_key
      WHERE e.event_name = 'output_completed'
        AND e.occurred_at > s4.output1_at
        ${accFilter}
      GROUP BY s4.actor_key
    ),
    s6_recharge_view AS (
      SELECT s5.actor_key, MIN(e.occurred_at) AS recharge_at
      FROM s5_second_output s5
      JOIN analytics_events e ON e.actor_key = s5.actor_key
      WHERE e.event_name IN ('recharge_page_viewed', 'payment_order_created', 'payment_paid')
        AND e.occurred_at >= s5.output2_at
        ${accFilter}
      GROUP BY s5.actor_key
    ),
    s7_order_create AS (
      SELECT s6.actor_key, MIN(e.occurred_at) AS order_at
      FROM s6_recharge_view s6
      JOIN analytics_events e ON e.actor_key = s6.actor_key
      WHERE e.event_name = 'payment_order_created'
        AND e.occurred_at >= s6.recharge_at
        ${accFilter}
      GROUP BY s6.actor_key
    ),
    s8_order_paid AS (
      SELECT s7.actor_key, MIN(e.occurred_at) AS paid_at
      FROM s7_order_create s7
      JOIN analytics_events e ON e.actor_key = s7.actor_key
      WHERE e.event_name = 'payment_paid'
        AND e.occurred_at >= s7.order_at
        ${accFilter}
      GROUP BY s7.actor_key
    )
    SELECT
      (SELECT COUNT(*) FROM reg_cohort) AS step1,
      (SELECT COUNT(*) FROM s2_brand) AS step2,
      (SELECT COUNT(*) FROM s3_trend) AS step3,
      (SELECT COUNT(*) FROM s4_first_output) AS step4,
      (SELECT COUNT(*) FROM s5_second_output) AS step5,
      (SELECT COUNT(*) FROM s6_recharge_view) AS step6,
      (SELECT COUNT(*) FROM s7_order_create) AS step7,
      (SELECT COUNT(*) FROM s8_order_paid) AS step8
  `).get(fromIso, toIso);

  const step1 = Number(funnelRow?.step1 || 0);
  const step2 = Number(funnelRow?.step2 || 0);
  const step3 = Number(funnelRow?.step3 || 0);
  const step4 = Number(funnelRow?.step4 || 0);
  const step5 = Number(funnelRow?.step5 || 0);
  const step6 = Number(funnelRow?.step6 || 0);
  const step7 = Number(funnelRow?.step7 || 0);
  const step8 = Number(funnelRow?.step8 || 0);

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

  // Video production funnel (strictly sequential)
  const vFunnelRow = db.prepare(`
    WITH v1_script AS (
      SELECT DISTINCT actor_key, occurred_at AS script_at
      FROM analytics_events e
      WHERE event_name = 'video_script_completed'
        AND occurred_at >= ? AND occurred_at < ?
        ${accFilter}
    ),
    v2_project AS (
      SELECT v1.actor_key, MIN(e.occurred_at) AS project_at
      FROM v1_script v1
      JOIN analytics_events e ON e.actor_key = v1.actor_key
      WHERE e.event_name = 'video_project_created'
        AND e.occurred_at >= v1.script_at
        ${accFilter}
      GROUP BY v1.actor_key
    ),
    v3_complete AS (
      SELECT v2.actor_key, MIN(e.occurred_at) AS complete_at
      FROM v2_project v2
      JOIN analytics_events e ON e.actor_key = v2.actor_key
      WHERE e.event_name = 'video_project_completed'
        AND e.occurred_at >= v2.project_at
        ${accFilter}
      GROUP BY v2.actor_key
    )
    SELECT
      (SELECT COUNT(DISTINCT actor_key) FROM v1_script) AS step1,
      (SELECT COUNT(*) FROM v2_project) AS step2,
      (SELECT COUNT(*) FROM v3_complete) AS step3
  `).get(fromIso, toIso);

  const vScript = Number(vFunnelRow?.step1 || 0);
  const vCreated = Number(vFunnelRow?.step2 || 0);
  const vCompleted = Number(vFunnelRow?.step3 || 0);

  const videoFunnel = [
    { step: "视频分镜脚本生成", count: vScript, rate: vScript > 0 ? 100 : 0 },
    { step: "发起视频项目制作", count: vCreated, rate: safePercent(vCreated, vScript) },
    { step: "最终视频成片完成", count: vCompleted, rate: safePercent(vCompleted, vScript) },
  ];

  // Retention (D1, D7, D30) for mature cohorts in range (computed via single CTE query)
  const todayJdRow = db.prepare("SELECT julianday(date(datetime(?, '+8 hours'))) AS jd").get(new Date(anchorInclusiveMs).toISOString());
  const todayJd = Number(todayJdRow?.jd || 0);

  const retentionRow = db.prepare(`
    WITH reg_users AS (
      SELECT
        actor_key,
        MIN(julianday(date(datetime(occurred_at, '+8 hours')))) AS reg_jd
      FROM analytics_events e
      WHERE event_name = 'user_registered'
        AND occurred_at >= ? AND occurred_at < ?
        ${accFilter}
      GROUP BY actor_key
    ),
    active_days AS (
      SELECT DISTINCT
        actor_key,
        julianday(date(datetime(occurred_at, '+8 hours'))) AS act_jd
      FROM analytics_events e
      WHERE event_name = 'user_active_day'
        ${accFilter}
    ),
    retention_flags AS (
      SELECT
        reg_users.actor_key,
        reg_users.reg_jd,
        MAX(CASE WHEN act.act_jd = reg_users.reg_jd + 1 THEN 1 ELSE 0 END) AS d1_retained,
        MAX(CASE WHEN act.act_jd = reg_users.reg_jd + 7 THEN 1 ELSE 0 END) AS d7_retained,
        MAX(CASE WHEN act.act_jd = reg_users.reg_jd + 30 THEN 1 ELSE 0 END) AS d30_retained
      FROM reg_users
      LEFT JOIN active_days act ON act.actor_key = reg_users.actor_key
      GROUP BY reg_users.actor_key, reg_users.reg_jd
    )
    SELECT
      SUM(CASE WHEN reg_jd <= ? - 1 THEN 1 ELSE 0 END) AS d1_cohort,
      SUM(CASE WHEN reg_jd <= ? - 1 THEN d1_retained ELSE 0 END) AS d1_retained,
      SUM(CASE WHEN reg_jd <= ? - 7 THEN 1 ELSE 0 END) AS d7_cohort,
      SUM(CASE WHEN reg_jd <= ? - 7 THEN d7_retained ELSE 0 END) AS d7_retained,
      SUM(CASE WHEN reg_jd <= ? - 30 THEN 1 ELSE 0 END) AS d30_cohort,
      SUM(CASE WHEN reg_jd <= ? - 30 THEN d30_retained ELSE 0 END) AS d30_retained,
      COUNT(*) AS total_cohort
    FROM retention_flags
  `).get(fromIso, toIso, todayJd, todayJd, todayJd, todayJd, todayJd, todayJd);

  const d1Cohort = Number(retentionRow?.d1_cohort || 0);
  const d1Retained = Number(retentionRow?.d1_retained || 0);
  const d7Cohort = Number(retentionRow?.d7_cohort || 0);
  const d7Retained = Number(retentionRow?.d7_retained || 0);
  const d30Cohort = Number(retentionRow?.d30_cohort || 0);
  const d30Retained = Number(retentionRow?.d30_retained || 0);

  const retention = {
    cohortSize: d1Cohort,
    d1CohortSize: d1Cohort,
    d1Retained,
    d1Rate: safePercent(d1Retained, d1Cohort),
    d7CohortSize: d7Cohort,
    d7Retained,
    d7Rate: safePercent(d7Retained, d7Cohort),
    d30CohortSize: d30Cohort,
    d30Retained,
    d30Rate: safePercent(d30Retained, d30Cohort),
  };

  // Account type distribution
  const accountDistribution = db.prepare(`
    SELECT account_type, COUNT(*) AS count
    FROM analytics_events e
    WHERE event_name = 'user_registered'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY account_type
  `).all(fromIso, toIso).map((r) => ({
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
  const attFilter = buildAccountFilter(accountType, "a");

  const featureStats = ANALYTICS_FEATURE_NAMES.map((feat) => {
    const label = ANALYTICS_FEATURE_LABELS[feat] || feat;

    const statsRow = db.prepare(`
      SELECT
        COUNT(DISTINCT actor_key) AS users_count,
        COUNT(DISTINCT CASE WHEN entity_type != '' AND entity_id != '' THEN entity_type || ':' || entity_id ELSE NULL END) AS requests_count,
        COUNT(DISTINCT CASE WHEN status = 'completed' AND entity_type != '' AND entity_id != '' THEN entity_type || ':' || entity_id ELSE NULL END) AS success_count,
        COUNT(DISTINCT CASE WHEN status = 'failed' AND entity_type != '' AND entity_id != '' THEN entity_type || ':' || entity_id ELSE NULL END) AS failure_count
      FROM analytics_events e
      WHERE feature = ?
        AND occurred_at >= ? AND occurred_at < ?
        ${accFilter}
    `).get(feat, fromIso, toIso);

    const creditsRow = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN event_name = 'credit_consumed' THEN credit_cost ELSE 0 END), 0) AS gross_credits,
        COALESCE(SUM(CASE WHEN event_name = 'credit_refunded' THEN credit_delta ELSE 0 END), 0) AS refund_credits
      FROM analytics_events e
      WHERE feature = ?
        AND occurred_at >= ? AND occurred_at < ?
        ${accFilter}
    `).get(feat, fromIso, toIso);

    const usersCount = Number(statsRow?.users_count || 0);
    const requestsCount = Number(statsRow?.requests_count || 0);
    const successCount = Number(statsRow?.success_count || 0);
    const failureCount = Number(statsRow?.failure_count || 0);
    const grossCredits = Number(creditsRow?.gross_credits || 0);
    const refundCredits = Number(creditsRow?.refund_credits || 0);
    const netCredits = grossCredits - refundCredits;

    // Daily trend
    const dailyRows = db.prepare(`
      SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COUNT(DISTINCT CASE WHEN entity_type != '' AND entity_id != '' THEN entity_type || ':' || entity_id ELSE NULL END) AS val
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
    FROM ai_task_attempts a
    WHERE status = 'failed'
      AND started_at >= ? AND started_at < ?
      ${attFilter}
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
  const { fromIso, toIso, accountType } = range;
  const coverage = getCoverageInfo(fromIso);
  const attFilter = buildAccountFilter(accountType, "a");

  // Summary across all AI attempts
  const summaryRow = db.prepare(`
    SELECT
      COUNT(*) AS total_requests,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN attempt_kind IN ('auto_retry', 'manual_retry', 'result_retry', 'assembly_retry') THEN 1 ELSE 0 END) AS retry_count,
      AVG(CASE WHEN duration_ms > 0 THEN duration_ms ELSE NULL END) AS avg_duration
    FROM ai_task_attempts a
    WHERE started_at >= ? AND started_at < ?
      AND task_type IN ('text_generation', 'image_generation', 'video_clip_generation')
      ${attFilter}
  `).get(fromIso, toIso);

  const totalRequests = Number(summaryRow?.total_requests || 0);
  const completedCount = Number(summaryRow?.completed_count || 0);
  const failedCount = Number(summaryRow?.failed_count || 0);
  const retryCount = Number(summaryRow?.retry_count || 0);
  const successRate = safePercent(completedCount, completedCount + failedCount);
  const retryRate = safePercent(retryCount, totalRequests);

  // Latency percentiles
  const durations = db.prepare(`
    SELECT duration_ms FROM ai_task_attempts a
    WHERE started_at >= ? AND started_at < ? AND duration_ms > 0
      AND task_type IN ('text_generation', 'image_generation', 'video_clip_generation')
      ${attFilter}
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
    FROM ai_task_attempts a
    WHERE started_at >= ? AND started_at < ?
      AND task_type IN ('text_generation', 'image_generation', 'video_clip_generation')
      ${attFilter}
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
    FROM ai_task_attempts a
    WHERE status = 'failed' AND started_at >= ? AND started_at < ?
      ${attFilter}
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
    FROM ai_task_attempts a
    WHERE status = 'failed' AND started_at >= ? AND started_at < ?
      ${attFilter}
    GROUP BY error_code, error_stage
    ORDER BY count DESC
    LIMIT 10
  `).all(fromIso, toIso).map((r) => ({
    code: r.error_code || "UNKNOWN",
    stage: r.error_stage || "unknown",
    count: Number(r.count || 0),
    sampleMessage: r.sample_message || "",
  }));

  // Immutable video facts are the historical source of truth. Runtime queue
  // rows are intentionally not joined so deleting a user cannot change history.
  const createdProjects = db.prepare(`
    SELECT entity_id, model, mode, resolution, aspect_ratio, media_duration_sec
    FROM analytics_events e
    WHERE event_name = 'video_project_created'
      AND occurred_at >= ? AND occurred_at < ?
      ${buildAccountFilter(accountType, "e")}
  `).all(fromIso, toIso);
  const terminalFacts = db.prepare(`
    SELECT entity_id, event_name, duration_ms, occurred_at
    FROM analytics_events e
    WHERE event_name IN ('video_project_completed', 'video_project_failed')
      ${buildAccountFilter(accountType, "e")}
    ORDER BY occurred_at ASC
  `).all();
  const terminalByProject = new Map();
  for (const row of terminalFacts) terminalByProject.set(String(row.entity_id), row);
  const videoAttempts = db.prepare(`
    SELECT project_id, clip_id, attempt_no, attempt_kind, status, duration_ms
    FROM ai_task_attempts a
    WHERE task_type = 'video_clip_generation'
      AND status IN ('completed', 'failed')
      ${attFilter}
  `).all();
  const attemptsByProject = new Map();
  for (const attempt of videoAttempts) {
    const key = String(attempt.project_id || "");
    if (!attemptsByProject.has(key)) attemptsByProject.set(key, []);
    attemptsByProject.get(key).push(attempt);
  }
  const creditFacts = db.prepare(`
    SELECT event_name, credit_cost, credit_delta,
      CAST(json_extract(metadata_json, '$.projectId') AS TEXT) AS project_id
    FROM analytics_events e
    WHERE event_name IN ('credit_consumed', 'credit_refunded')
      AND feature = 'video_project'
      ${buildAccountFilter(accountType, "e")}
  `).all();
  const creditsByProject = new Map();
  for (const fact of creditFacts) {
    const key = String(fact.project_id || "");
    if (!key) continue;
    const totals = creditsByProject.get(key) || { gross: 0, refund: 0 };
    if (fact.event_name === "credit_consumed") totals.gross += Number(fact.credit_cost || 0);
    else totals.refund += Number(fact.credit_delta || 0);
    creditsByProject.set(key, totals);
  }
  const groups = new Map();
  for (const project of createdProjects) {
    const groupKey = [project.model, project.mode, project.resolution, project.aspect_ratio, project.media_duration_sec].join("|");
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(project);
  }
  const videoComparison = [...groups.values()].map((projects) => {
    const sample = projects[0];
    let completedCount = 0;
    let failedCount = 0;
    let firstSuccessCount = 0;
    let autoRetryCount = 0;
    let manualRetryCount = 0;
    let rescueCount = 0;
    let retryMatureCount = 0;
    let grossCredits = 0;
    let refundCredits = 0;
    const projectDurations = [];
    const clipDurations = [];
    for (const project of projects) {
      const projectId = String(project.entity_id);
      const terminal = terminalByProject.get(projectId);
      const isCompleted = terminal?.event_name === "video_project_completed";
      const isFailed = terminal?.event_name === "video_project_failed";
      if (isCompleted) {
        completedCount += 1;
        projectDurations.push(Number(terminal.duration_ms || 0));
      }
      if (isFailed) failedCount += 1;
      const attempts = (attemptsByProject.get(projectId) || []).sort((a, b) => Number(a.attempt_no) - Number(b.attempt_no));
      const initialAttempts = attempts.filter((attempt) => attempt.attempt_kind === "initial");
      const hasAuto = attempts.some((attempt) => attempt.attempt_kind === "auto_retry");
      const hasManual = attempts.some((attempt) => attempt.attempt_kind === "manual_retry");
      const clipIds = new Set(attempts.map((attempt) => String(attempt.clip_id || "")).filter(Boolean));
      const allClipInitialAttemptsCompleted = clipIds.size > 0
        && [...clipIds].every((clipId) => {
          const clipInitialAttempts = initialAttempts.filter((attempt) => String(attempt.clip_id || "") === clipId);
          return clipInitialAttempts.length > 0 && clipInitialAttempts.every((attempt) => attempt.status === "completed");
        });
      const hasInitialFailure = initialAttempts.some((attempt) => attempt.status === "failed");
      if (isCompleted && allClipInitialAttemptsCompleted && !hasInitialFailure && !hasAuto && !hasManual) firstSuccessCount += 1;
      if (hasAuto) autoRetryCount += 1;
      if (hasManual) manualRetryCount += 1;
      if ((isCompleted || isFailed) && (hasAuto || hasManual)) retryMatureCount += 1;
      if (isCompleted && (hasAuto || hasManual)) rescueCount += 1;
      clipDurations.push(...attempts.map((attempt) => Number(attempt.duration_ms || 0)));
      const credit = creditsByProject.get(projectId) || { gross: 0, refund: 0 };
      grossCredits += credit.gross;
      refundCredits += credit.refund;
    }
    const matureCount = completedCount + failedCount;
    const netCredits = grossCredits - refundCredits;
    const successSeconds = projects
      .filter((project) => terminalByProject.get(String(project.entity_id))?.event_name === "video_project_completed")
      .reduce((sum, project) => sum + Number(project.media_duration_sec || 0), 0);
    return {
      model: sample.model,
      mode: sample.mode,
      resolution: sample.resolution,
      aspectRatio: sample.aspect_ratio,
      totalDurationSec: Number(sample.media_duration_sec || 0),
      projectCount: projects.length,
      matureCount,
      activeCount: projects.length - matureCount,
      waitingConfigCount: 0,
      completionRate: safePercent(completedCount, matureCount),
      firstSuccessRate: safePercent(firstSuccessCount, matureCount),
      autoRetryRate: safePercent(autoRetryCount, matureCount),
      manualRetryRate: safePercent(manualRetryCount, matureCount),
      rescueRate: safePercent(rescueCount, retryMatureCount),
      p50DurationMs: percentile(projectDurations, 0.5),
      p95DurationMs: percentile(projectDurations, 0.95),
      clipP50DurationMs: percentile(clipDurations, 0.5),
      clipP95DurationMs: percentile(clipDurations, 0.95),
      grossCredits,
      refundCredits,
      netCredits,
      avgNetCredits: projects.length ? Math.round((netCredits / projects.length) * 10) / 10 : null,
      netCreditsPerSuccessSecond: successSeconds ? Math.round((netCredits / successSeconds) * 10) / 10 : null,
      vendorCost: null,
      vendorCostLabel: "未配置",
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    range: { from: fromIso, to: toIso, timezone: range.timezone, accountType },
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
  const accFilter = buildAccountFilter(accountType, "e");
  const userAccFilter = accountType ? `AND u.account_type = '${accountType}'` : "";

  // Total Revenue & Paid Orders from payment_paid facts (by occurred_at = paid_at)
  const paidRow = db.prepare(`
    SELECT
      COUNT(*) AS paid_orders,
      COALESCE(SUM(amount_fen), 0) AS paid_amount_fen,
      COUNT(DISTINCT actor_key) AS paying_users
    FROM analytics_events e
    WHERE event_name = 'payment_paid'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(fromIso, toIso);

  // Total Orders Created from payment_order_created facts (by occurred_at = created_at)
  const createdRow = db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM analytics_events paid
        WHERE paid.event_name = 'payment_paid'
          AND paid.entity_type = e.entity_type
          AND paid.entity_id = e.entity_id
          AND paid.is_admin = 0
      ) THEN 1 ELSE 0 END) AS cohort_paid,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM analytics_events failed
        WHERE failed.event_name = 'payment_failed'
          AND failed.entity_type = e.entity_type
          AND failed.entity_id = e.entity_id
          AND failed.is_admin = 0
      ) AND NOT EXISTS (
        SELECT 1 FROM analytics_events paid
        WHERE paid.event_name = 'payment_paid'
          AND paid.entity_type = e.entity_type
          AND paid.entity_id = e.entity_id
          AND paid.is_admin = 0
      ) THEN 1 ELSE 0 END) AS expired_or_failed
    FROM analytics_events e
    WHERE event_name = 'payment_order_created'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(fromIso, toIso);

  const totalOrders = Number(createdRow?.total_orders || 0);
  const paidInPeriod = Number(paidRow?.paid_orders || 0);
  const cohortPaid = Number(createdRow?.cohort_paid || 0);
  const expiredOrFailed = Number(createdRow?.expired_or_failed || 0);
  const pendingUnexpired = Math.max(0, totalOrders - cohortPaid - expiredOrFailed);
  const paidAmountFen = Number(paidRow?.paid_amount_fen || 0);
  const payingUsers = Number(paidRow?.paying_users || 0);
  const revenueYuan = paidAmountFen / 100;
  const arppu = payingUsers > 0 ? Math.round((revenueYuan / payingUsers) * 10) / 10 : 0;
  const conversionRate = safePercent(cohortPaid, totalOrders);

  // Channel comparison: Alipay vs WeChat from payment_paid facts
  const channelComparison = db.prepare(`
    SELECT
      provider,
      COUNT(*) AS paid_orders,
      COALESCE(SUM(amount_fen), 0) / 100.0 AS revenue_yuan
    FROM analytics_events e
    WHERE event_name = 'payment_paid'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY provider
  `).all(fromIso, toIso).map((r) => ({
    provider: r.provider,
    providerLabel: r.provider === "wxpay" ? "微信支付" : "支付宝",
    paidOrders: Number(r.paid_orders || 0),
    revenueYuan: Number(r.revenue_yuan || 0),
  }));

  // Plan package distribution from payment_paid facts
  const planDistribution = db.prepare(`
    SELECT
      json_extract(metadata_json, '$.planId') AS plan_id,
      json_extract(metadata_json, '$.planName') AS plan_name,
      COUNT(*) AS orders_count,
      COALESCE(SUM(amount_fen), 0) / 100.0 AS revenue_yuan
    FROM analytics_events e
    WHERE event_name = 'payment_paid'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY plan_id, plan_name
    ORDER BY revenue_yuan DESC
  `).all(fromIso, toIso).map((r) => ({
    planId: r.plan_id || "default",
    planName: r.plan_name || r.plan_id || "标准套餐",
    ordersCount: Number(r.orders_count || 0),
    revenueYuan: Number(r.revenue_yuan || 0),
  }));

  // Daily revenue trend from payment_paid facts
  const revDailyRows = db.prepare(`
    SELECT strftime('%Y-%m-%d', datetime(occurred_at, '+8 hours')) AS day, COALESCE(SUM(amount_fen), 0) / 100.0 AS val
    FROM analytics_events e
    WHERE event_name = 'payment_paid'
      AND occurred_at >= ? AND occurred_at < ?
      ${accFilter}
    GROUP BY day
  `).all(fromIso, toIso);
  const revMap = new Map(revDailyRows.map((r) => [r.day, r.val]));
  const revenueSeries = intervals.map((d) => ({ date: d, value: Number(revMap.get(d) || 0) }));

  // Credits pool: Gross, Refund, Net, Admin Granted
  const creditsRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN event_name = 'credit_consumed' THEN credit_cost ELSE 0 END), 0) AS gross_credits,
      COALESCE(SUM(CASE WHEN event_name = 'credit_refunded' THEN credit_delta ELSE 0 END), 0) AS refund_credits,
      COALESCE(SUM(CASE WHEN event_name = 'credit_granted' THEN credit_delta ELSE 0 END), 0) AS admin_granted_credits
    FROM analytics_events e
    WHERE occurred_at >= ? AND occurred_at < ?
      ${accFilter}
  `).get(fromIso, toIso);
  const grossCredits = Number(creditsRow?.gross_credits || 0);
  const refundCredits = Number(creditsRow?.refund_credits || 0);
  const netCredits = grossCredits - refundCredits;
  const adminGrantedCredits = Number(creditsRow?.admin_granted_credits || 0);

  const currentRemainingCredits = db.prepare(`
    SELECT COALESCE(SUM(u.credits), 0) AS total FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM analytics_events e
      WHERE e.event_name = 'user_registered'
        AND e.entity_id = CAST(u.id AS TEXT)
        AND e.is_admin = 1
    )
    ${userAccFilter}
  `).get()?.total || 0;

  const auditIssuesCount = db.prepare("SELECT COUNT(*) AS cnt FROM payment_orders WHERE audit_reason != ''").get()?.cnt || 0;

  return {
    generatedAt: new Date().toISOString(),
    range: { from: fromIso, to: toIso, timezone: range.timezone, accountType },
    coverage,
    overview: {
      revenueYuan,
      payingUsers,
      arppu,
      totalOrders,
      paidOrders: paidInPeriod,
      paidInPeriod,
      createdInPeriod: totalOrders,
      cohortPaid,
      pendingUnexpired,
      expiredOrFailed,
      conversionRate,
      grossCredits,
      refundCredits,
      netCredits,
      currentRemainingCredits: Number(currentRemainingCredits),
      adminGrantedCredits,
      auditIssuesCount: Number(auditIssuesCount),
    },
    channelComparison,
    planDistribution,
    revenueSeries,
  };
}

function getSystemMetrics(query = {}, { videoProjectService } = {}) {
  const systemRange = parseQueryRange(query);
  const coverage = getCoverageInfo(systemRange.fromIso);
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
    WHERE started_at >= ? AND is_admin = 0
      AND task_type IN ('text_generation', 'image_generation', 'video_clip_generation')
  `).get(last24hIso);
  const aiErrorsLast24h = Number(ai24h?.failed || 0);
  const aiSuccessRateLast24h = safePercent(ai24h?.completed, Number(ai24h?.completed || 0) + Number(ai24h?.failed || 0));

  const lat24h = db.prepare(`
    SELECT duration_ms FROM ai_task_attempts
    WHERE started_at >= ? AND duration_ms > 0 AND is_admin = 0
      AND task_type IN ('text_generation', 'image_generation', 'video_clip_generation')
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
    coverage,
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
