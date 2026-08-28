const { getDbProxy } = require("../db/connection");
const { insertAnalyticsEvent, insertAiTaskAttempt, setAnalyticsMeta, getAnalyticsMeta } = require("./analytics-repository");
const { ANALYTICS_FEATURES, GENERATION_TYPE_TO_FEATURE } = require("./analytics-constants");

function actionTypeToFeature(actionType) {
  const t = String(actionType || "");
  if (t === "momentsImage") return "moments";
  if (t === "wechatImage") return "wechat_long_image";
  if (t === "xhsCarousel" || t === "xhsCarouselSlide") return "xhs_carousel";
  if (t === "styleImage") return "style_image";
  if (t === "imageEdit") return "image_edit";
  if (t === "videoScript") return "video_script";
  if (t === "videoProject" || t === "videoProjectRetry") return "video_project";
  if (t === "trend_analysis" || t === "trendAnalysis") return "trend_analysis";
  if (t === "excellent_direction" || t === "excellentDirection") return "excellent_direction";
  if (t === "excellent_fusion" || t === "excellentFusion") return "excellent_fusion";
  return "";
}

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
    const brands = db.prepare(`
      SELECT b.id, b.owner_user_id, b.created_at, u.account_type
      FROM brands b
      LEFT JOIN users u ON u.id = b.owner_user_id
      WHERE b.created_at IS NOT NULL AND b.created_at != ''
    `).all();
    for (const b of brands) {
      updateMaxDate(b.created_at);
      const inserted = insertAnalyticsEvent({
        eventKey: `brand_created:${b.id}`,
        eventName: "brand_created",
        occurredAt: b.created_at,
        actorUserId: b.owner_user_id,
        accountType: b.account_type || "customer",
        entityType: "brand",
        entityId: String(b.id),
      });
      if (inserted) backfilledEvents++;
    }
  }

  // 3. Payment Orders -> created, paid, failed
  if (tableExists("payment_orders")) {
    const orders = db.prepare(`
      SELECT p.id, p.user_id, p.plan_id, p.plan_name, p.plan_credits, p.amount_fen, p.status, p.provider, p.created_at, p.paid_at, p.updated_at, u.account_type
      FROM payment_orders p
      LEFT JOIN users u ON u.id = p.user_id
    `).all();
    for (const o of orders) {
      updateMaxDate(o.created_at);
      updateMaxDate(o.paid_at);
      // Created
      const cIns = insertAnalyticsEvent({
        eventKey: `payment_order_created:${o.id}`,
        eventName: "payment_order_created",
        occurredAt: o.created_at || new Date().toISOString(),
        actorUserId: o.user_id,
        accountType: o.account_type || "customer",
        entityType: "payment_order",
        entityId: String(o.id),
        provider: o.provider,
        amountFen: Number(o.amount_fen || 0),
        metadata: { planId: o.plan_id, planName: o.plan_name, planCredits: o.plan_credits },
      });
      if (cIns) backfilledEvents++;

      // Paid
      if (o.status === "paid") {
        const pIns = insertAnalyticsEvent({
          eventKey: `payment_paid:${o.id}`,
          eventName: "payment_paid",
          occurredAt: o.paid_at || o.updated_at || o.created_at || new Date().toISOString(),
          actorUserId: o.user_id,
          accountType: o.account_type || "customer",
          status: "paid",
          entityType: "payment_order",
          entityId: String(o.id),
          provider: o.provider,
          amountFen: Number(o.amount_fen || 0),
          creditDelta: Number(o.plan_credits || 0),
          metadata: { planId: o.plan_id, planName: o.plan_name, planCredits: o.plan_credits },
        });
        if (pIns) backfilledEvents++;
      } else if (["failed", "expired"].includes(o.status)) {
        const fIns = insertAnalyticsEvent({
          eventKey: `payment_failed:${o.id}`,
          eventName: "payment_failed",
          occurredAt: o.updated_at || o.created_at || new Date().toISOString(),
          actorUserId: o.user_id,
          accountType: o.account_type || "customer",
          status: "failed",
          entityType: "payment_order",
          entityId: String(o.id),
          provider: o.provider,
          amountFen: Number(o.amount_fen || 0),
        });
        if (fIns) backfilledEvents++;
      }
    }
  }

  // 4. Credit Events -> consumed, refunded, granted
  if (tableExists("credit_events")) {
    const events = db.prepare(`
      SELECT e.id, e.user_id, e.action_type, e.credit_delta, e.credit_cost, e.created_at, e.generation_id, e.admin_user_id, e.payload_json, u.account_type
      FROM credit_events e
      LEFT JOIN users u ON u.id = e.user_id
    `).all();
    for (const e of events) {
      updateMaxDate(e.created_at);
      const delta = Number(e.credit_delta || 0);
      const feature = actionTypeToFeature(e.action_type);
      if (delta < 0) {
        const cost = Math.abs(Number(e.credit_cost || delta));
        const ins = insertAnalyticsEvent({
          eventKey: `credit_consumed:${e.id}`,
          eventName: "credit_consumed",
          occurredAt: e.created_at,
          actorUserId: e.user_id,
          accountType: e.account_type || "customer",
          feature,
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
            accountType: e.account_type || "customer",
            feature,
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
            accountType: e.account_type || "customer",
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
    const gens = db.prepare(`
      SELECT g.id, g.owner_user_id, g.type, g.created_at, g.preview_url, g.payload_json, u.account_type
      FROM generations g
      LEFT JOIN users u ON u.id = g.owner_user_id
    `).all();
    for (const g of gens) {
      updateMaxDate(g.created_at);
      const feature = GENERATION_TYPE_TO_FEATURE[g.type] || g.type || "other";
      // Check if truly completed
      if (g.type === "videoProject") {
        const project = db.prepare("SELECT status FROM video_projects WHERE generation_id = ?").get(g.id);
        if (!project || project.status !== "completed") continue;
      } else if (g.type === "xhsCarousel") {
        try {
          const p = JSON.parse(g.payload_json || "{}");
          const slides = Array.isArray(p.slides) ? p.slides : [];
          const isGroup = p.generatedMode === "group" || (slides.length === 4 && slides.every((s) => s.imageUrl || s.previewUrl));
          if (!isGroup) continue;
        } catch {
          continue;
        }
      }
      const ins = insertAnalyticsEvent({
        eventKey: `output_completed:${g.id}`,
        eventName: "output_completed",
        occurredAt: g.created_at,
        actorUserId: g.owner_user_id,
        accountType: g.account_type || "customer",
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
    const reqs = db.prepare(`
      SELECT r.request_id, r.user_id, r.brand_id, r.bucket_key, r.status, r.credit_cost, r.created_at, r.updated_at, u.account_type
      FROM trend_analysis_requests r
      LEFT JOIN users u ON u.id = r.user_id
    `).all();
    for (const r of reqs) {
      updateMaxDate(r.created_at);
      updateMaxDate(r.updated_at);
      insertAnalyticsEvent({
        eventKey: `trend_analysis_started:${r.request_id}`,
        eventName: "trend_analysis_started",
        occurredAt: r.created_at,
        actorUserId: r.user_id,
        accountType: r.account_type || "customer",
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
          accountType: r.account_type || "customer",
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
          accountType: r.account_type || "customer",
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
    const requests = db.prepare(`
      SELECT r.request_id, r.user_id, r.kind, r.status, r.credit_cost, r.created_at, r.completed_at, r.updated_at, u.account_type
      FROM excellent_remix_billing_requests r
      LEFT JOIN users u ON u.id = r.user_id
    `).all();
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
          accountType: r.account_type || "customer",
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
          accountType: r.account_type || "customer",
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
    const scripts = db.prepare(`
      SELECT s.request_id, s.user_id, s.brand_id, s.status, s.credit_cost, s.generation_id, s.created_at, s.updated_at, u.account_type
      FROM video_script_requests s
      LEFT JOIN users u ON u.id = s.user_id
    `).all();
    for (const s of scripts) {
      updateMaxDate(s.created_at);
      updateMaxDate(s.updated_at);
      insertAnalyticsEvent({
        eventKey: `video_script_started:${s.request_id}`,
        eventName: "video_script_started",
        occurredAt: s.created_at,
        actorUserId: s.user_id,
        accountType: s.account_type || "customer",
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
          accountType: s.account_type || "customer",
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
          accountType: s.account_type || "customer",
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
    const projects = db.prepare(`
      SELECT p.id, p.owner_user_id, p.video_model, p.mode, p.resolution, p.aspect_ratio, p.total_duration_sec, p.status, p.estimated_credits, p.charged_credits, p.refunded_credits, p.created_at, p.updated_at, u.account_type
      FROM video_projects p
      LEFT JOIN users u ON u.id = p.owner_user_id
    `).all();
    for (const p of projects) {
      updateMaxDate(p.created_at);
      updateMaxDate(p.updated_at);
      insertAnalyticsEvent({
        eventKey: `video_project_created:${p.id}`,
        eventName: "video_project_created",
        occurredAt: p.created_at,
        actorUserId: p.owner_user_id,
        accountType: p.account_type || "customer",
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
          accountType: p.account_type || "customer",
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
          accountType: p.account_type || "customer",
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
    const jobs = db.prepare(`
      SELECT j.id, j.owner_user_id, j.status, j.provider, j.model, j.error, j.created_at_ms, j.updated_at, j.completed_at, u.account_type
      FROM image_jobs j
      LEFT JOIN users u ON u.id = j.owner_user_id
    `).all();
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
        accountType: j.account_type || "customer",
        isBackfilled: 1,
      });
      if (ins) backfilledAttempts++;
    }
  }

  // 11. AI Task Attempts: Historical Video Clips
  if (tableExists("video_clips")) {
    const clips = db.prepare(`
      SELECT c.id, c.project_id, c.clip_index, c.status, c.provider, c.attempt, c.retry_count, c.provider_key_ref, c.error, c.created_at, c.updated_at, p.owner_user_id, u.account_type
      FROM video_clips c
      JOIN video_projects p ON p.id = c.project_id
      LEFT JOIN users u ON u.id = p.owner_user_id
    `).all();
    for (const c of clips) {
      const startedAt = c.created_at || new Date().toISOString();
      updateMaxDate(startedAt);
      const clipStatus = ["completed", "failed"].includes(c.status) ? c.status : "running";
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
        status: clipStatus,
        errorStage: c.error ? "provider" : "",
        errorMessage: c.error || "",
        startedAt,
        completedAt: c.updated_at || startedAt,
        actorUserId: c.owner_user_id,
        accountType: c.account_type || "customer",
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

function ensureUserAnalyticsBackfill(userId) {
  const uid = Number(userId);
  if (!uid) return { ok: false, error: "Invalid userId" };

  const user = db.prepare("SELECT id, account_type, created_at FROM users WHERE id = ?").get(uid);
  if (!user) return { ok: false, error: "User not found" };

  // 1. User registered
  insertAnalyticsEvent({
    eventKey: `user_registered:${user.id}`,
    eventName: "user_registered",
    occurredAt: user.created_at || new Date().toISOString(),
    actorUserId: user.id,
    accountType: user.account_type || "customer",
    entityType: "user",
    entityId: String(user.id),
  });

  // 2. Brands
  if (tableExists("brands")) {
    const brands = db.prepare("SELECT id, owner_user_id, created_at FROM brands WHERE owner_user_id = ? AND created_at IS NOT NULL AND created_at != ''").all(uid);
    for (const b of brands) {
      insertAnalyticsEvent({
        eventKey: `brand_created:${b.id}`,
        eventName: "brand_created",
        occurredAt: b.created_at,
        actorUserId: b.owner_user_id,
        accountType: user.account_type || "customer",
        entityType: "brand",
        entityId: String(b.id),
      });
    }
  }

  // 3. Payment orders
  if (tableExists("payment_orders")) {
    const orders = db.prepare("SELECT id, user_id, plan_id, plan_name, plan_credits, amount_fen, status, provider, created_at, paid_at, updated_at FROM payment_orders WHERE user_id = ?").all(uid);
    for (const o of orders) {
      insertAnalyticsEvent({
        eventKey: `payment_order_created:${o.id}`,
        eventName: "payment_order_created",
        occurredAt: o.created_at || new Date().toISOString(),
        actorUserId: o.user_id,
        accountType: user.account_type || "customer",
        entityType: "payment_order",
        entityId: String(o.id),
        provider: o.provider,
        amountFen: Number(o.amount_fen || 0),
        metadata: { planId: o.plan_id, planName: o.plan_name, planCredits: o.plan_credits },
      });
      if (o.status === "paid") {
        insertAnalyticsEvent({
          eventKey: `payment_paid:${o.id}`,
          eventName: "payment_paid",
          occurredAt: o.paid_at || o.updated_at || o.created_at || new Date().toISOString(),
          actorUserId: o.user_id,
          accountType: user.account_type || "customer",
          status: "paid",
          entityType: "payment_order",
          entityId: String(o.id),
          provider: o.provider,
          amountFen: Number(o.amount_fen || 0),
          creditDelta: Number(o.plan_credits || 0),
          metadata: { planId: o.plan_id, planName: o.plan_name, planCredits: o.plan_credits },
        });
      } else if (["failed", "expired"].includes(o.status)) {
        insertAnalyticsEvent({
          eventKey: `payment_failed:${o.id}`,
          eventName: "payment_failed",
          occurredAt: o.updated_at || o.created_at || new Date().toISOString(),
          actorUserId: o.user_id,
          accountType: user.account_type || "customer",
          status: "failed",
          entityType: "payment_order",
          entityId: String(o.id),
          provider: o.provider,
          amountFen: Number(o.amount_fen || 0),
        });
      }
    }
  }

  // 4. Credit Events
  if (tableExists("credit_events")) {
    const events = db.prepare("SELECT id, user_id, action_type, credit_delta, credit_cost, created_at, generation_id, admin_user_id, payload_json FROM credit_events WHERE user_id = ?").all(uid);
    for (const e of events) {
      const delta = Number(e.credit_delta || 0);
      const feature = actionTypeToFeature(e.action_type);
      if (delta < 0) {
        const cost = Math.abs(Number(e.credit_cost || delta));
        insertAnalyticsEvent({
          eventKey: `credit_consumed:${e.id}`,
          eventName: "credit_consumed",
          occurredAt: e.created_at,
          actorUserId: e.user_id,
          accountType: user.account_type || "customer",
          feature,
          entityType: "credit_event",
          entityId: String(e.id),
          sourceTable: "generations",
          sourceId: e.generation_id ? String(e.generation_id) : "",
          creditDelta: -cost,
          creditCost: cost,
          metadata: { actionType: e.action_type },
        });
      } else if (delta > 0) {
        const action = String(e.action_type || "").toLowerCase();
        if (action.includes("refund")) {
          insertAnalyticsEvent({
            eventKey: `credit_refunded:${e.id}`,
            eventName: "credit_refunded",
            occurredAt: e.created_at,
            actorUserId: e.user_id,
            accountType: user.account_type || "customer",
            feature,
            entityType: "credit_event",
            entityId: String(e.id),
            creditDelta: delta,
            metadata: { actionType: e.action_type },
          });
        } else if (!action.includes("recharge")) {
          insertAnalyticsEvent({
            eventKey: `credit_granted:${e.id}`,
            eventName: "credit_granted",
            occurredAt: e.created_at,
            actorUserId: e.user_id,
            accountType: user.account_type || "customer",
            entityType: "credit_event",
            entityId: String(e.id),
            creditDelta: delta,
            metadata: { actionType: e.action_type, adminUserId: e.admin_user_id },
          });
        }
      }
    }
  }

  // 5. Generations
  if (tableExists("generations")) {
    const gens = db.prepare("SELECT id, owner_user_id, type, created_at, preview_url, payload_json FROM generations WHERE owner_user_id = ?").all(uid);
    for (const g of gens) {
      const feature = GENERATION_TYPE_TO_FEATURE[g.type] || g.type || "other";
      if (g.type === "videoProject") {
        const project = db.prepare("SELECT status FROM video_projects WHERE generation_id = ?").get(g.id);
        if (!project || project.status !== "completed") continue;
      } else if (g.type === "xhsCarousel") {
        try {
          const p = JSON.parse(g.payload_json || "{}");
          const slides = Array.isArray(p.slides) ? p.slides : [];
          const isGroup = p.generatedMode === "group" || (slides.length === 4 && slides.every((s) => s.imageUrl || s.previewUrl));
          if (!isGroup) continue;
        } catch {
          continue;
        }
      }
      insertAnalyticsEvent({
        eventKey: `output_completed:${g.id}`,
        eventName: "output_completed",
        occurredAt: g.created_at,
        actorUserId: g.owner_user_id,
        accountType: user.account_type || "customer",
        feature,
        status: "completed",
        entityType: "generation",
        entityId: String(g.id),
      });
    }
  }

  // 6. Video Projects & Clips
  if (tableExists("video_projects")) {
    const projects = db.prepare("SELECT id, owner_user_id, video_model, mode, resolution, aspect_ratio, total_duration_sec, status, estimated_credits, charged_credits, refunded_credits, created_at, updated_at FROM video_projects WHERE owner_user_id = ?").all(uid);
    for (const p of projects) {
      insertAnalyticsEvent({
        eventKey: `video_project_created:${p.id}`,
        eventName: "video_project_created",
        occurredAt: p.created_at,
        actorUserId: p.owner_user_id,
        accountType: user.account_type || "customer",
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
        insertAnalyticsEvent({
          eventKey: `video_project_completed:${p.id}`,
          eventName: "video_project_completed",
          occurredAt: p.updated_at || p.created_at,
          actorUserId: p.owner_user_id,
          accountType: user.account_type || "customer",
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
      } else if (["failed", "project_data_failed"].includes(p.status)) {
        insertAnalyticsEvent({
          eventKey: `video_project_failed:${p.id}`,
          eventName: "video_project_failed",
          occurredAt: p.updated_at || p.created_at,
          actorUserId: p.owner_user_id,
          accountType: user.account_type || "customer",
          feature: ANALYTICS_FEATURES.VIDEO_PROJECT,
          status: "failed",
          entityType: "video_project",
          entityId: String(p.id),
          model: p.video_model,
          mode: p.mode,
        });
      }
    }
  }

  return { ok: true };
}

module.exports = {
  ensureAnalyticsBackfill,
  ensureUserAnalyticsBackfill,
};
