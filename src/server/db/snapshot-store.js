const fsp = require("fs/promises");
const { DATA_DIR } = require("../config");
const { openDatabase, getDbProxy } = require("./connection");
const {
  createEmptyStore,
  normalizeStore,
  flattenTrendBuckets,
} = require("./snapshot-utils");
const {
  tableExists,
  hasCurrentStoreSchema,
  isSchemaCurrent,
  initializeDatabaseSchema,
  ensureDatabaseIndexes,
  ensureSchemaUpgrades,
} = require("./schema");
const { migrateSchemaIfNeeded } = require("./migrations");
const { readStoreFromDbAnySchema } = require("./legacy-readers");

const db = getDbProxy();

async function ensureStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  openDatabase();
  initializeDatabaseSchema();
  ensureSchemaUpgrades();
  await migrateSchemaIfNeeded({
    tableExists,
    isSchemaCurrent,
    readStoreFromDbAnySchema,
    normalizeStore,
    initializeDatabaseSchema,
    writeStore,
  });
  ensureDatabaseIndexes();

  const hasUsers = tableExists("users") && db.prepare("SELECT COUNT(*) AS count FROM users").get().count > 0;
  if (!hasUsers) {
    await writeStore(createEmptyStore());
    return;
  }

  const { store, changed } = normalizeStore(readStoreFromDbAnySchema());
  if (changed) {
    await writeStore(store);
  }
}

async function readStore() {
  const { store, changed } = normalizeStore(readStoreFromDbAnySchema());
  if (changed) {
    await writeStore(store);
  }
  return store;
}

function mapBy(items, keySelector) {
  const map = new Map();
  for (const item of items || []) {
    map.set(keySelector(item), item);
  }
  return map;
}

function sameStoreRecord(left, right) {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function deleteMissingRows(currentItems, keySelector, nextKeys, deleteRow) {
  const nextKeySet = new Set((nextKeys || []).map((key) => String(key)));
  for (const item of currentItems || []) {
    const key = keySelector(item);
    if (!nextKeySet.has(String(key))) {
      deleteRow(key);
    }
  }
}

async function writeStore(data) {
  const store = normalizeStore(data).store;
  const current = hasCurrentStoreSchema() ? readStoreFromDbAnySchema() : createEmptyStore();

  const upsertCounter = db.prepare(`
    INSERT INTO counters (name, value) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value
  `);
  const upsertUser = db.prepare(`
    INSERT INTO users (id, name, phone, password, account_type, department, credits, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      phone = excluded.phone,
      password = excluded.password,
      account_type = excluded.account_type,
      department = excluded.department,
      credits = excluded.credits,
      created_at = excluded.created_at
  `);
  const deleteUser = db.prepare("DELETE FROM users WHERE id = ?");
  const upsertSession = db.prepare(`
    INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      user_id = excluded.user_id,
      created_at = excluded.created_at
  `);
  const deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");
  const upsertVerification = db.prepare(`
    INSERT INTO verification_codes (phone, code, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      code = excluded.code,
      expires_at = excluded.expires_at
  `);
  const deleteVerification = db.prepare("DELETE FROM verification_codes WHERE phone = ?");
  const upsertBrand = db.prepare(`
    INSERT INTO brands (
      id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base, logo_json, asset_tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      name = excluded.name,
      industry = excluded.industry,
      audience = excluded.audience,
      description = excluded.description,
      product = excluded.product,
      goal = excluded.goal,
      knowledge_base = excluded.knowledge_base,
      logo_json = excluded.logo_json,
      asset_tags_json = excluded.asset_tags_json
  `);
  const deleteBrand = db.prepare("DELETE FROM brands WHERE id = ?");
  const deleteBrandIdeas = db.prepare("DELETE FROM ideas WHERE trend_row_id IN (SELECT row_id FROM trends WHERE brand_id = ?)");
  const deleteBrandTrends = db.prepare("DELETE FROM trends WHERE brand_id = ?");
  const deleteBrandAnalyses = db.prepare("DELETE FROM analyses WHERE brand_id = ?");
  const insertAnalysis = db.prepare("INSERT INTO analyses (id, brand_id, name, timestamp, position) VALUES (?, ?, ?, ?, ?)");
  const insertTrend = db.prepare(`
    INSERT INTO trends (
      trend_id, brand_id, analysis_id, scope, bucket_key, bucket_title, bucket_description, rank, title, category, summary, score, reason, custom_prompt, system_prompt, tags_json, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIdea = db.prepare(`
    INSERT INTO ideas (
      trend_row_id, idea_index, title, summary, angle, brand_fit, audience, hook, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertGeneration = db.prepare(`
    INSERT INTO generations (
      id, owner_user_id, type, channel_label, brand_id, brand_name, trend_id, trend_title, idea_title,
      card_title, created_at, preview_url, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      type = excluded.type,
      channel_label = excluded.channel_label,
      brand_id = excluded.brand_id,
      brand_name = excluded.brand_name,
      trend_id = excluded.trend_id,
      trend_title = excluded.trend_title,
      idea_title = excluded.idea_title,
      card_title = excluded.card_title,
      created_at = excluded.created_at,
      preview_url = excluded.preview_url,
      summary = excluded.summary,
      payload_json = excluded.payload_json
  `);
  const deleteGeneration = db.prepare("DELETE FROM generations WHERE id = ?");
  const upsertProductImage = db.prepare(`
    INSERT INTO product_images (
      id, owner_user_id, original_name, stored_path, mime_type, size_bytes, sha256, created_at, last_used_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      original_name = excluded.original_name,
      stored_path = excluded.stored_path,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      sha256 = excluded.sha256,
      created_at = excluded.created_at,
      last_used_at = excluded.last_used_at,
      deleted_at = excluded.deleted_at
  `);
  const deleteProductImage = db.prepare("DELETE FROM product_images WHERE id = ?");
  const upsertImageJob = db.prepare(`
    INSERT INTO image_jobs (
      id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
      metadata_json, generation_context_json, image_url, error, generation_id,
      created_at_ms, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      status = excluded.status,
      provider = excluded.provider,
      provider_mode = excluded.provider_mode,
      provider_result_url = excluded.provider_result_url,
      model = excluded.model,
      metadata_json = excluded.metadata_json,
      generation_context_json = excluded.generation_context_json,
      image_url = excluded.image_url,
      error = excluded.error,
      generation_id = excluded.generation_id,
      created_at_ms = excluded.created_at_ms,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at
  `);
  const deleteImageJob = db.prepare("DELETE FROM image_jobs WHERE id = ?");
  const upsertCreditEvent = db.prepare(`
    INSERT INTO credit_events (
      id, user_id, action_type, action_label, credit_delta, credit_cost, created_at,
      admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title, idea_title,
      generation_id, channel_label, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      action_type = excluded.action_type,
      action_label = excluded.action_label,
      credit_delta = excluded.credit_delta,
      credit_cost = excluded.credit_cost,
      created_at = excluded.created_at,
      admin_user_id = excluded.admin_user_id,
      admin_user_name = excluded.admin_user_name,
      brand_id = excluded.brand_id,
      brand_name = excluded.brand_name,
      trend_id = excluded.trend_id,
      trend_title = excluded.trend_title,
      idea_title = excluded.idea_title,
      generation_id = excluded.generation_id,
      channel_label = excluded.channel_label,
      summary = excluded.summary,
      payload_json = excluded.payload_json
  `);
  const deleteCreditEvent = db.prepare("DELETE FROM credit_events WHERE id = ?");

  db.exec("BEGIN IMMEDIATE");
  try {
    upsertCounter.run("nextUserId", store.nextUserId);
    upsertCounter.run("nextBrandId", store.nextBrandId);
    upsertCounter.run("nextAnalysisId", store.nextAnalysisId);
    upsertCounter.run("nextTrendId", store.nextTrendId);
    upsertCounter.run("nextGenerationId", store.nextGenerationId);
    upsertCounter.run("nextCreditEventId", store.nextCreditEventId);
    upsertCounter.run("nextProductImageId", store.nextProductImageId);

    const currentUsersById = mapBy(current.users, (item) => item.id);
    const currentSessionsByToken = mapBy(current.sessions, (item) => item.token);
    const currentVerificationsByPhone = new Map(
      Object.entries(current.verificationCodes || {}).map(([phone, record]) => [String(phone), { phone, ...record }]),
    );
    const currentBrandsById = mapBy(current.brands, (item) => item.id);
    const currentGenerationsById = mapBy(current.generations, (item) => item.id);
    const currentProductImagesById = mapBy(current.productImages, (item) => item.id);
    const currentImageJobsById = mapBy(current.imageJobs, (item) => item.id);
    const currentCreditEventsById = mapBy(current.creditEvents, (item) => item.id);

    for (const user of store.users) {
      if (!sameStoreRecord(currentUsersById.get(user.id), user)) {
        upsertUser.run(
          user.id,
          user.name,
          user.phone,
          user.password,
          user.accountType || "customer",
          user.department || "",
          Number(user.credits || 0),
          user.createdAt,
        );
      }
    }
    deleteMissingRows(current.users, (item) => item.id, store.users.map((item) => item.id), (id) => deleteUser.run(id));

    for (const session of store.sessions) {
      if (!sameStoreRecord(currentSessionsByToken.get(session.token), session)) {
        upsertSession.run(session.token, session.userId, session.createdAt);
      }
    }
    deleteMissingRows(
      current.sessions,
      (item) => item.token,
      store.sessions.map((item) => item.token),
      (token) => deleteSession.run(token),
    );

    for (const [phone, record] of Object.entries(store.verificationCodes || {})) {
      const nextRecord = { phone, code: record.code, expiresAt: record.expiresAt };
      if (!sameStoreRecord(currentVerificationsByPhone.get(String(phone)), nextRecord)) {
        upsertVerification.run(phone, record.code, record.expiresAt);
      }
    }
    deleteMissingRows(
      Array.from(currentVerificationsByPhone.values()),
      (item) => item.phone,
      Object.keys(store.verificationCodes || {}),
      (phone) => deleteVerification.run(phone),
    );

    const deleteBrandContent = (brandId) => {
      deleteBrandIdeas.run(brandId);
      deleteBrandTrends.run(brandId);
      deleteBrandAnalyses.run(brandId);
    };

    const insertBrandContent = (brand) => {
      for (const [analysisPosition, analysis] of (brand.analyses || []).entries()) {
        insertAnalysis.run(analysis.id, brand.id, analysis.name, analysis.timestamp, analysisPosition);

        for (const [trendPosition, trend] of flattenTrendBuckets(analysis.trendSnapshot).entries()) {
          const trendResult = insertTrend.run(
            trend.id,
            brand.id,
            analysis.id,
            "snapshot",
            trend.bucketKey || "global",
            trend.bucketTitle || "全网热点指数",
            trend.bucketDescription || "从跨平台高讨论度内容里筛选可被品牌借势的热点方向。",
            trend.rank,
            trend.title,
            trend.category,
            trend.summary,
            trend.score,
            trend.reason,
            trend.customPrompt || "",
            trend.systemPrompt || "",
              JSON.stringify(Array.isArray(trend.tags) ? trend.tags : []),
              trendPosition,
          );

          for (const [ideaIndex, idea] of (trend.ideas || []).entries()) {
            insertIdea.run(
              trendResult.lastInsertRowid,
              ideaIndex,
              idea.title,
              idea.summary,
              idea.angle,
              idea.brandFit,
              idea.audience,
              idea.hook,
              JSON.stringify(Array.isArray(idea.tags) ? idea.tags : []),
            );
          }
        }
      }

      for (const [trendPosition, trend] of flattenTrendBuckets(brand.trends).entries()) {
        const trendResult = insertTrend.run(
          trend.id,
          brand.id,
          null,
          "current",
          trend.bucketKey || "global",
          trend.bucketTitle || "全网热点指数",
          trend.bucketDescription || "从跨平台高讨论度内容里筛选可被品牌借势的热点方向。",
          trend.rank,
          trend.title,
          trend.category,
          trend.summary,
          trend.score,
          trend.reason,
          trend.customPrompt || "",
          trend.systemPrompt || "",
          JSON.stringify(Array.isArray(trend.tags) ? trend.tags : []),
          trendPosition,
        );

        for (const [ideaIndex, idea] of (trend.ideas || []).entries()) {
          insertIdea.run(
            trendResult.lastInsertRowid,
            ideaIndex,
            idea.title,
            idea.summary,
            idea.angle,
            idea.brandFit,
            idea.audience,
            idea.hook,
            JSON.stringify(Array.isArray(idea.tags) ? idea.tags : []),
          );
        }
      }
    };

    deleteMissingRows(current.brands, (item) => item.id, store.brands.map((item) => item.id), (id) => {
      deleteBrandContent(id);
      deleteBrand.run(id);
    });

    for (const brand of store.brands) {
      if (sameStoreRecord(currentBrandsById.get(brand.id), brand)) continue;
      upsertBrand.run(
        brand.id,
        brand.ownerUserId,
        brand.name,
        brand.industry,
        brand.audience,
        brand.description,
        brand.product,
        brand.goal,
        brand.knowledgeBase || "",
        JSON.stringify(brand.logo || {}),
        JSON.stringify(Array.isArray(brand.assetTags) ? brand.assetTags : []),
      );
      deleteBrandContent(brand.id);
      insertBrandContent(brand);
    }

    for (const item of store.generations || []) {
      if (!sameStoreRecord(currentGenerationsById.get(item.id), item)) {
        upsertGeneration.run(
          item.id,
          item.ownerUserId,
          item.type,
          item.channelLabel,
          item.brandId,
          item.brandName,
          item.trendId,
          item.trendTitle,
          item.ideaTitle,
          item.cardTitle,
          item.createdAt,
          item.previewUrl || "",
          item.summary || "",
          JSON.stringify(item.payload || {}),
        );
      }
    }
    deleteMissingRows(
      current.generations,
      (item) => item.id,
      (store.generations || []).map((item) => item.id),
      (id) => deleteGeneration.run(id),
    );

    for (const image of store.productImages || []) {
      if (!sameStoreRecord(currentProductImagesById.get(image.id), image)) {
        upsertProductImage.run(
          image.id,
          image.ownerUserId,
          image.originalName,
          image.storedPath,
          image.mimeType,
          Number(image.sizeBytes || 0),
          image.sha256,
          image.createdAt,
          image.lastUsedAt || "",
          image.deletedAt || "",
        );
      }
    }
    deleteMissingRows(
      current.productImages,
      (item) => item.id,
      (store.productImages || []).map((item) => item.id),
      (id) => deleteProductImage.run(id),
    );

    for (const job of store.imageJobs || []) {
      if (!sameStoreRecord(currentImageJobsById.get(job.id), job)) {
        upsertImageJob.run(
          job.id,
          job.ownerUserId,
          job.status,
          job.provider,
          job.providerMode || "",
          job.providerResultUrl || "",
          job.model || "",
          JSON.stringify(job.metadata || {}),
          JSON.stringify(job.generationContext || {}),
          job.imageUrl || "",
          job.error || "",
          job.generationId,
          Number(job.createdAt || Date.now()),
          job.updatedAt || "",
          job.completedAt || "",
        );
      }
    }
    deleteMissingRows(
      current.imageJobs,
      (item) => item.id,
      (store.imageJobs || []).map((item) => item.id),
      (id) => deleteImageJob.run(id),
    );

    for (const event of store.creditEvents || []) {
      if (!sameStoreRecord(currentCreditEventsById.get(event.id), event)) {
        upsertCreditEvent.run(
          event.id,
          event.userId,
          event.actionType,
          event.actionLabel,
          Number(event.creditDelta || 0),
          Number(event.creditCost || 0),
          event.createdAt,
          event.adminUserId,
          event.adminUserName || "",
          event.brandId,
          event.brandName || "",
          event.trendId,
          event.trendTitle || "",
          event.ideaTitle || "",
          event.generationId,
          event.channelLabel || "",
          event.summary || "",
          JSON.stringify(event.payload || {}),
        );
      }
    }
    deleteMissingRows(
      current.creditEvents,
      (item) => item.id,
      (store.creditEvents || []).map((item) => item.id),
      (id) => deleteCreditEvent.run(id),
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = {
  ensureStore,
  readStore,
  writeStore,
};
