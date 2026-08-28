const { getDbProxy } = require("../db/connection");
const { insertAnalyticsEvent, insertAiTaskAttempt, setAnalyticsMeta, getAnalyticsMeta } = require("./analytics-repository");
const { ANALYTICS_FEATURES, GENERATION_TYPE_TO_FEATURE } = require("./analytics-constants");

const db = getDbProxy();

function tableExists(name) {
  return db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(name).count > 0;
}

function ensureAnalyticsBackfill() {
  let backfilledEvents = 0;
  let backfilledAttempts = 0;
  let maxSourceDate = "";

  function updateMaxDate(dateStr) {
    if (dateStr && dateStr > maxSourceDate) {
      maxSourceDate = String(dateStr);
    }
  }

  // 1. Users -> user_registered
  if (tableExists("users")) {
    const users = db.prepare("SELECT id, account_type, created_at FROM users").all();
    for (const u of users) {
      updateMaxDate(u.created_at);
      const inserted = insertAnalyticsEvent({
        eventKey: `user_registered:${u.id}`,
        eventName: "user_registered",
        occurredAt: u.created_at || new Date().toISOString(),
        actorUserId: u.id,
        accountType: u.account_type || "customer",
        entityType: "user",
        entityId: String(u.id),
      });
      if (inserted) backfilledEvents++;
    }
  }

  // 2. Brands -> brand_created (only where created_at is valid)
  if (tableExists("brands")) {
    const brands = db.prepare("SELECT id, owner_user_id, created_at FROM brands WHERE created_at IS NOT NULL AND created_at != ''").all();
    for (const b of brands) {
      updateMaxDate(b.created_at);
      const inserted = insertAnalyticsEvent({
        eventKey: `brand_created:${b.id}`,
        eventName: "brand_created",
        occurredAt: b.created_at,
        actorUserId: b.owner_user_id,
        entityType: "brand",
        entityId: String(b.id),
      });
      if (inserted) backfilledEvents++;
    }
  }

  // 3. Payment Orders -> created, paid, failed
  if (tableExists("payment_orders")) {
    const orders = db.prepare("SELECT out_trade_no, user_id, plan_id, plan_credits, amount_fen, status, provider, created_at, paid_at, updated_at FROM payment_orders").all();
    for (const o of orders) {
      updateMaxDate(o.created_at);
      updateMaxDate(o.paid_at);
      // Created
      const cIns = insertAnalyticsEvent({
        eventKey: `payment_order_created:${o.out_trade_no}`,
        eventName: "payment_order_created",
        occurredAt: o.created_at || new Date().toISOString(),
        actorUserId: o.user_id,
        entityType: "payment_order",
        entityId: String(o.out_trade_no),
        provider: o.provider,
        amountFen: Number(o.amount_fen || 0),
        metadata: { planId: o.plan_id },
      });
      if (cIns) backfilledEvents++;

      // Paid
      if (o.status === "paid") {
        const pIns = insertAnalyticsEvent({
          eventKey: `payment_paid:${o.out_trade_no}`,
          eventName: "payment_paid",
          occurredAt: o.paid_at || o.updated_at || o.created_at || new Date().toISOString(),
          actorUserId: o.user_id,
          status: "paid",
          entityType: "payment_order",
          entityId: String(o.out_trade_no),
          provider: o.provider,
          amountFen: Number(o.amount_fen || 0),
          creditDelta: Number(o.plan_credits || 0),
          metadata: { planId: o.plan_id },
        });
        if (pIns) backfilledEvents++;
      } else if (["failed", "expired"].includes(o.status)) {
        const fIns = insertAnalyticsEvent({
          eventKey: `payment_failed:${o.out_trade_no}`,
          eventName: "payment_failed",
          occurredAt: o.updated_at || o.created_at || new Date().toISOString(),
          actorUserId: o.user_id,
          status: "failed",
          entityType: "payment_order",
          entityId: String(o.out_trade_no),
          provider: o.provider,
          amountFen: Number(o.amount_fen || 0),
        });
        if (fIns) backfilledEvents++;
      }
    }
  }

  // 4. Credit Events -> consumed, refunded, granted
  if (tableExists("credit_events")) {
    const events = db.prepare("SELECT id, user_id, action_type, credit_delta, credit_cost, created_at, generation_id, admin_user_id, payload_json FROM credit_events").all();
    for (const e of events) {
      updateMaxDate(e.created_at);
      const delta = Number(e.credit_delta || 0);
      if (delta < 0) {
        const cost = Math.abs(Number(e.credit_cost || delta));
        const ins = insertAnalyticsEvent({
          eventKey: `credit_consumed:${e.id}`,
          eventName: "credit_consumed",
          occurredAt: e.created_at,
          actorUserId: e.user_id,
          entityType: "credit_event",
          entityId: String(e.id),
          sourceTable: "generations",
          sourceId: e.generation_id ? String(e.generation_id) : "",
          creditDelta: -cost,
          creditCost: cost,
          metadata: { actionType: e.action_type },
        });
        if (ins) backfilledEvents++;
      } else if (delta > 0) {
        const action = String(e.action_type || "").toLowerCase();
        if (action.includes("refund")) {
          const ins = insertAnalyticsEvent({
            eventKey: `credit_refunded:${e.id}`,
            eventName: "credit_refunded",
            occurredAt: e.created_at,
            actorUserId: e.user_id,
            entityType: "credit_event",
            entityId: String(e.id),
            creditDelta: delta,
            metadata: { actionType: e.action_type },
          });
          if (ins) backfilledEvents++;
        } else if (!action.includes("recharge")) {
          const ins = insertAnalyticsEvent({
            eventKey: `credit_granted:${e.id}`,
            eventName: "credit_granted",
            occurredAt: e.created_at,
            actorUserId: e.user_id,
            entityType: "credit_event",
            entityId: String(e.id),
            creditDelta: delta,
            metadata: { actionType: e.action_type, adminUserId: e.admin_user_id },
          });
          if (ins) backfilledEvents++;
        }
      }
    }
  }

  // 5. Generations -> output_completed
  if (tableExists("generations")) {
    const gens = db.prepare("SELECT id, owner_user_id, type, created_at FROM generations").all();
    for (const g of gens) {
      updateMaxDate(g.created_at);
      const feature = GENERATION_TYPE_TO_FEATURE[g.type] || g.type || "other";
      const ins = insertAnalyticsEvent({
        eventKey: `output_completed:${g.id}`,
        eventName: "output_completed",
        occurredAt: g.created_at,
        actorUserId: g.owner_user_id,
        feature,
        status: "completed",
        entityType: "generation",
        entityId: String(g.id),
      });
      if (ins) backfilledEvents++;
    }
  }

  // 6. Trend Analysis Requests
  if (tableExists("trend_analysis_requests")) {
    const reqs = db.prepare("SELECT request_id, user_id, brand_id, bucket_key, status, credit_cost, created_at, updated_at FROM trend_analysis_requests").all();
    for (const r of reqs) {
      updateMaxDate(r.created_at);
      updateMaxDate(r.updated_at);
      insertAnalyticsEvent({
        eventKey: `trend_analysis_started:${r.request_id}`,
        eventName: "trend_analysis_started",
        occurredAt: r.created_at,
        actorUserId: r.user_id,
        feature: ANALYTICS_FEATURES.TREND_ANALYSIS,
        entityType: "trend_analysis",
        entityId: String(r.request_id),
        metadata: { brandId: r.brand_id, bucketKey: r.bucket_key },
      });
      if (r.status === "completed") {
        const ins = insertAnalyticsEvent({
          eventKey: `trend_analysis_completed:${r.request_id}`,
          eventName: "trend_analysis_completed",
          occurredAt: r.updated_at || r.created_at,
          actorUserId: r.user_id,
          feature: ANALYTICS_FEATURES.TREND_ANALYSIS,
          status: "completed",
          entityType: "trend_analysis",
          entityId: String(r.request_id),
          metadata: { brandId: r.brand_id, bucketKey: r.bucket_key },
        });
        if (ins) backfilledEvents++;
      } else if (r.status === "failed") {
        const ins = insertAnalyticsEvent({
          eventKey: `trend_analysis_failed:${r.request_id}`,
          eventName: "trend_analysis_failed",
          occurredAt: r.updated_at || r.created_at,
          actorUserId: r.user_id,
          feature: ANALYTICS_FEATURES.TREND_ANALYSIS,
          status: "failed",
          entityType: "trend_analysis",
          entityId: String(r.request_id),
        });
        if (ins) backfilledEvents++;
      }
    }
  }

  // 7. Excellent Remix Billing Requests
  if (tableExists("excellent_remix_billing_requests")) {
    const requests = db.prepare("SELECT request_id, user_id, kind, status, credit_cost, created_at, completed_at, updated_at FROM excellent_remix_billing_requests").all();
    for (const r of requests) {
      updateMaxDate(r.created_at);
      updateMaxDate(r.completed_at || r.updated_at);
      const isDirection = r.kind === "direction";
      const feature = isDirection ? ANALYTICS_FEATURES.EXCELLENT_DIRECTION : ANALYTICS_FEATURES.EXCELLENT_FUSION;
      if (r.status === "completed") {
        const eventName = isDirection ? "excellent_direction_completed" : "excellent_fusion_completed";
        const ins = insertAnalyticsEvent({
          eventKey: `${eventName}:${r.request_id}`,
          eventName,
          occurredAt: r.completed_at || r.updated_at || r.created_at,
          actorUserId: r.user_id,
          feature,
          status: "completed",
          entityType: r.kind,
          entityId: String(r.request_id),
          creditCost: Number(r.credit_cost || 0),
        });
        if (ins) backfilledEvents++;
      } else if (r.status === "failed") {
        const eventName = isDirection ? "excellent_direction_failed" : "excellent_fusion_failed";
        const ins = insertAnalyticsEvent({
          eventKey: `${eventName}:${r.request_id}`,
          eventName,
          occurredAt: r.updated_at || r.created_at,
          actorUserId: r.user_id,
          feature,
          status: "failed",
          entityType: r.kind,
          entityId: String(r.request_id),
        });
        if (ins) backfilledEvents++;
      }
    }
  }

  // 8. Video Script Requests
  if (tableExists("video_script_requests")) {
    const scripts = db.prepare("SELECT request_id, user_id, brand_id, status, credit_cost, generation_id, created_at, updated_at FROM video_script_requests").all();
    for (const s of scripts) {
      updateMaxDate(s.created_at);
      updateMaxDate(s.updated_at);
      insertAnalyticsEvent({
        eventKey: `video_script_started:${s.request_id}`,
        eventName: "video_script_started",
        occurredAt: s.created_at,
        actorUserId: s.user_id,
        feature: ANALYTICS_FEATURES.VIDEO_SCRIPT,
        entityType: "video_script",
        entityId: String(s.request_id),
      });
      if (s.status === "completed") {
        const ins = insertAnalyticsEvent({
          eventKey: `video_script_completed:${s.request_id}`,
          eventName: "video_script_completed",
          occurredAt: s.updated_at || s.created_at,
          actorUserId: s.user_id,
          feature: ANALYTICS_FEATURES.VIDEO_SCRIPT,
          status: "completed",
          entityType: "video_script",
          entityId: String(s.request_id),
          sourceTable: "generations",
          sourceId: s.generation_id ? String(s.generation_id) : "",
          creditCost: Number(s.credit_cost || 1),
        });
        if (ins) backfilledEvents++;
      } else if (s.status === "failed") {
        const ins = insertAnalyticsEvent({
          eventKey: `video_script_failed:${s.request_id}`,
          eventName: "video_script_failed",
          occurredAt: s.updated_at || s.created_at,
          actorUserId: s.user_id,
          feature: ANALYTICS_FEATURES.VIDEO_SCRIPT,
          status: "failed",
          entityType: "video_script",
          entityId: String(s.request_id),
        });
        if (ins) backfilledEvents++;
      }
    }
  }

  // 9. Video Projects & Video Clips
  if (tableExists("video_projects")) {
    const projects = db.prepare("SELECT id, owner_user_id, video_model, mode, resolution, aspect_ratio, total_duration_sec, status, estimated_credits, charged_credits, refunded_credits, created_at, updated_at FROM video_projects").all();
    for (const p of projects) {
      updateMaxDate(p.created_at);
      updateMaxDate(p.updated_at);
      insertAnalyticsEvent({
        eventKey: `video_project_created:${p.id}`,
        eventName: "video_project_created",
        occurredAt: p.created_at,
        actorUserId: p.owner_user_id,
        feature: ANALYTICS_FEATURES.VIDEO_PROJECT,
        entityType: "video_project",
        entityId: String(p.id),
        model: p.video_model,
        mode: p.mode,
        resolution: p.resolution,
        aspectRatio: p.aspect_ratio,
        mediaDurationSec: Number(p.total_duration_sec || 0),
        creditCost: Number(p.estimated_credits || 0),
      });
      if (p.status === "completed") {
        const netCredits = Number(p.charged_credits || 0) - Number(p.refunded_credits || 0);
        const ins = insertAnalyticsEvent({
          eventKey: `video_project_completed:${p.id}`,
          eventName: "video_project_completed",
          occurredAt: p.updated_at || p.created_at,
          actorUserId: p.owner_user_id,
          feature: ANALYTICS_FEATURES.VIDEO_PROJECT,
          status: "completed",
          entityType: "video_project",
          entityId: String(p.id),
          model: p.video_model,
          mode: p.mode,
          resolution: p.resolution,
          aspectRatio: p.aspect_ratio,
          mediaDurationSec: Number(p.total_duration_sec || 0),
          creditCost: netCredits,
        });
        if (ins) backfilledEvents++;
      } else if (["failed", "project_data_failed"].includes(p.status)) {
        const ins = insertAnalyticsEvent({
          eventKey: `video_project_failed:${p.id}`,
          eventName: "video_project_failed",
          occurredAt: p.updated_at || p.created_at,
          actorUserId: p.owner_user_id,
          feature: ANALYTICS_FEATURES.VIDEO_PROJECT,
          status: "failed",
          entityType: "video_project",
          entityId: String(p.id),
          model: p.video_model,
          mode: p.mode,
        });
        if (ins) backfilledEvents++;
      }
    }
  }

  // 10. AI Task Attempts: Historical Image Jobs
  if (tableExists("image_jobs")) {
    const jobs = db.prepare("SELECT id, owner_user_id, status, provider, model, error, created_at_ms, updated_at, completed_at FROM image_jobs").all();
    for (const j of jobs) {
      const startedAt = j.created_at_ms ? new Date(j.created_at_ms).toISOString() : new Date().toISOString();
      updateMaxDate(startedAt);
      const ins = insertAiTaskAttempt({
        attemptKey: `image_job_backfill:${j.id}`,
        feature: "style_image",
        taskType: "image_generation",
        entityType: "image_job",
        entityId: String(j.id),
        provider: j.provider || "keystone",
        model: j.model || "",
        attemptKind: "historical_summary",
        status: j.status || "completed",
        errorStage: j.error ? "provider" : "",
        errorMessage: j.error || "",
        startedAt,
        completedAt: j.completedAt || j.updated_at || startedAt,
        actorUserId: j.owner_user_id,
        isBackfilled: 1,
      });
      if (ins) backfilledAttempts++;
    }
  }

  // 11. AI Task Attempts: Historical Video Clips
  if (tableExists("video_clips")) {
    const clips = db.prepare("SELECT id, project_id, clip_index, status, provider, attempt, retry_count, provider_key_ref, error, created_at, updated_at FROM video_clips").all();
    for (const c of clips) {
      const startedAt = c.created_at || new Date().toISOString();
      updateMaxDate(startedAt);
      const ins = insertAiTaskAttempt({
        attemptKey: `video_clip_backfill:${c.project_id}:${c.clip_index}`,
        feature: "video_project",
        taskType: "video_clip_generation",
        entityType: "video_project",
        entityId: String(c.project_id),
        projectId: c.project_id,
        clipId: c.id,
        provider: c.provider || "",
        providerKeyRef: c.provider_key_ref || "",
        attemptKind: "historical_summary",
        attemptNo: Math.max(1, Number(c.attempt || 1)),
        status: c.status === "completed" ? "completed" : "failed",
        errorStage: c.error ? "provider" : "",
        errorMessage: c.error || "",
        startedAt,
        completedAt: c.updated_at || startedAt,
        isBackfilled: 1,
      });
      if (ins) backfilledAttempts++;
    }
  }

  const nowIso = new Date().toISOString();
  setAnalyticsMeta("backfill_completed_at", nowIso);
  if (maxSourceDate) {
    setAnalyticsMeta("backfill_source_max_at", maxSourceDate);
  }

  return {
    backfilledEvents,
    backfilledAttempts,
    backfillCompletedAt: nowIso,
    backfillSourceMaxAt: maxSourceDate,
  };
}

module.exports = {
  ensureAnalyticsBackfill,
};
