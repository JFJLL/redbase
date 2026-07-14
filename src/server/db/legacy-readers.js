const { getDbProxy } = require("./connection");
const { hasColumn, hasCurrentStoreSchema, tableExists } = require("./schema");
const { normalizeBrandLogo, groupTrendRows, safeParseArray, safeParseObject } = require("./snapshot-utils");

const db = getDbProxy();

function readStoreFromDbAnySchema() {
  if (hasCurrentStoreSchema()) {
    return readStoreFromCurrentSchema();
  }
  return readStoreFromLegacySchema();
}

function readStoreFromCurrentSchema() {
  const counters = Object.fromEntries(
    db.prepare("SELECT name, value FROM counters").all().map((row) => [row.name, row.value]),
  );

  const users = db.prepare("SELECT id, name, phone, password, account_type, department, credits, created_at FROM users ORDER BY id ASC").all().map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    password: row.password,
    accountType: row.account_type,
    department: row.department,
    credits: row.credits,
    createdAt: row.created_at,
  }));

  const sessions = db.prepare("SELECT token, user_id, created_at FROM sessions ORDER BY created_at DESC").all().map((row) => ({
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
  }));

  const verificationCodes = Object.fromEntries(
    db.prepare("SELECT phone, code, expires_at FROM verification_codes").all().map((row) => [
      row.phone,
      { code: row.code, expiresAt: row.expires_at },
    ]),
  );

  const brandLogoColumn = hasColumn("brands", "logo_json") ? "logo_json" : "'{}' AS logo_json";
  const brands = db.prepare(`
    SELECT id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base, ${brandLogoColumn}, asset_tags_json
    FROM brands
    ORDER BY id DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    industry: row.industry,
    audience: row.audience,
    description: row.description,
    product: row.product,
    goal: row.goal,
    knowledgeBase: row.knowledge_base,
    logo: normalizeBrandLogo(safeParseObject(row.logo_json)),
    assetTags: safeParseArray(row.asset_tags_json),
    analyses: [],
    trends: [],
  }));

  const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
  const analysisMap = new Map();
  const analysisRows = db.prepare(`
    SELECT id, brand_id, name, timestamp, position
    FROM analyses
    ORDER BY brand_id DESC, position ASC
  `).all();

  for (const row of analysisRows) {
    const brand = brandMap.get(row.brand_id);
    if (!brand) continue;
    const analysis = {
      id: row.id,
      name: row.name,
      timestamp: row.timestamp,
      trendSnapshot: [],
    };
    brand.analyses.push(analysis);
    analysisMap.set(row.id, analysis);
  }

  const trendRows = db.prepare(`
    SELECT row_id, trend_id, brand_id, analysis_id, scope, bucket_key, bucket_title, bucket_description, rank, title, category, summary, score, reason, custom_prompt, system_prompt, tags_json
    FROM trends
    ORDER BY brand_id DESC, scope ASC, analysis_id ASC, bucket_key ASC, position ASC
  `).all();

  for (const row of trendRows) {
    const trend = {
      id: row.trend_id,
      bucketKey: row.bucket_key,
      bucketTitle: row.bucket_title,
      bucketDescription: row.bucket_description,
      rank: row.rank,
      title: row.title,
      category: row.category,
      summary: row.summary,
      score: row.score,
      tags: safeParseArray(row.tags_json),
      reason: row.reason,
      customPrompt: row.custom_prompt || "",
      ideas: readIdeasForTrendRow(row.row_id),
    };

    if (row.scope === "current") {
      const brand = brandMap.get(row.brand_id);
      if (brand) {
        groupTrendRows([trend], brand.trends);
      }
      continue;
    }

    const analysis = analysisMap.get(row.analysis_id);
    if (analysis) {
      groupTrendRows([trend], analysis.trendSnapshot);
    }
  }

  const generations = db.prepare(`
    SELECT id, owner_user_id, type, channel_label, brand_id, brand_name, trend_id, trend_title, idea_title,
      card_title, created_at, preview_url, summary, payload_json
    FROM generations
    ORDER BY created_at DESC, id DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    type: row.type,
    channelLabel: row.channel_label,
    brandId: row.brand_id,
    brandName: row.brand_name,
    trendId: row.trend_id,
    trendTitle: row.trend_title,
    ideaTitle: row.idea_title,
    cardTitle: row.card_title,
    createdAt: row.created_at,
    previewUrl: row.preview_url,
    summary: row.summary,
    payload: safeParseObject(row.payload_json),
  }));

  const creditEvents = db.prepare(`
    SELECT id, user_id, action_type, action_label, credit_delta, credit_cost, created_at,
      admin_user_id, admin_user_name, brand_id, brand_name, trend_id, trend_title, idea_title,
      generation_id, channel_label, summary, payload_json
    FROM credit_events
    ORDER BY created_at DESC, id DESC
  `).all().map((row) => ({
    id: row.id,
    userId: row.user_id,
    actionType: row.action_type,
    actionLabel: row.action_label,
    creditDelta: row.credit_delta,
    creditCost: row.credit_cost,
    createdAt: row.created_at,
    adminUserId: row.admin_user_id,
    adminUserName: row.admin_user_name,
    brandId: row.brand_id,
    brandName: row.brand_name,
    trendId: row.trend_id,
    trendTitle: row.trend_title,
    ideaTitle: row.idea_title,
    generationId: row.generation_id,
    channelLabel: row.channel_label,
    summary: row.summary,
    payload: safeParseObject(row.payload_json),
  }));

  const productImages = db.prepare(`
    SELECT id, owner_user_id, original_name, stored_path, mime_type, size_bytes, sha256, created_at, last_used_at, deleted_at
    FROM product_images
    ORDER BY created_at DESC, id DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    originalName: row.original_name,
    storedPath: row.stored_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || "",
    deletedAt: row.deleted_at || "",
  }));

  const imageJobs = db.prepare(`
    SELECT id, owner_user_id, status, provider, provider_mode, provider_result_url, model,
      metadata_json, generation_context_json, image_url, error, generation_id,
      created_at_ms, updated_at, completed_at
    FROM image_jobs
    ORDER BY created_at_ms DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    provider: row.provider,
    providerMode: row.provider_mode || "",
    providerResultUrl: row.provider_result_url || "",
    model: row.model || "",
    metadata: safeParseObject(row.metadata_json),
    generationContext: safeParseObject(row.generation_context_json),
    imageUrl: row.image_url || "",
    error: row.error || "",
    generationId: row.generation_id == null ? null : row.generation_id,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at || "",
    completedAt: row.completed_at || "",
  }));

  return {
    nextUserId: counters.nextUserId,
    nextBrandId: counters.nextBrandId,
    nextAnalysisId: counters.nextAnalysisId,
    nextTrendId: counters.nextTrendId,
    nextGenerationId: counters.nextGenerationId,
    nextCreditEventId: counters.nextCreditEventId,
    nextProductImageId: counters.nextProductImageId,
    users,
    sessions,
    verificationCodes,
    brands,
    generations,
    creditEvents,
    productImages,
    imageJobs,
  };
}

function readIdeasForTrendRow(trendRowId) {
  return db.prepare(`
    SELECT idea_index, title, summary, angle, brand_fit, audience, hook, tags_json, content_assets_json
    FROM ideas
    WHERE trend_row_id = ?
    ORDER BY idea_index ASC
  `).all(trendRowId).map((row) => ({
    title: row.title,
    summary: row.summary,
    angle: row.angle,
    brandFit: row.brand_fit,
    audience: row.audience,
    hook: row.hook,
    tags: safeParseArray(row.tags_json),
    contentAssets: safeParseObject(row.content_assets_json),
  }));
}

function readStoreFromLegacySchema() {
  const counters = Object.fromEntries(
    db.prepare("SELECT name, value FROM counters").all().map((row) => [row.name, row.value]),
  );

  const users = db.prepare("SELECT id, name, phone, password, created_at FROM users ORDER BY id ASC").all().map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    password: row.password,
    accountType: "yimei",
    department: "其他",
    credits: 50,
    createdAt: row.created_at,
  }));

  const sessions = db.prepare("SELECT token, user_id, created_at FROM sessions ORDER BY created_at DESC").all().map((row) => ({
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
  }));

  const verificationCodes = Object.fromEntries(
    db.prepare("SELECT phone, code, expires_at FROM verification_codes").all().map((row) => [
      row.phone,
      { code: row.code, expiresAt: row.expires_at },
    ]),
  );

  const brands = db.prepare(`
    SELECT id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base
    FROM brands
    ORDER BY id DESC
  `).all().map((row) => ({
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    industry: row.industry,
    audience: row.audience,
    description: row.description,
    product: row.product,
    goal: row.goal,
    knowledgeBase: row.knowledge_base,
    assetTags: readLegacyBrandAssetTags(row.id),
    analyses: [],
    trends: [],
  }));

  const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
  const analysisRows = db.prepare(`
    SELECT id, brand_id, name, timestamp, position
    FROM analyses
    ORDER BY brand_id DESC, position ASC
  `).all();

  for (const row of analysisRows) {
    const brand = brandMap.get(row.brand_id);
    if (!brand) continue;
    brand.analyses.push({
      id: row.id,
      name: row.name,
      timestamp: row.timestamp,
      trendSnapshot: readLegacyAnalysisTrends(row.id),
    });
  }

  for (const brand of brands) {
    brand.trends = readLegacyCurrentTrends(brand.id);
  }

  return {
    nextUserId: counters.nextUserId,
    nextBrandId: counters.nextBrandId,
    nextAnalysisId: counters.nextAnalysisId,
    nextTrendId: counters.nextTrendId,
    nextGenerationId: counters.nextGenerationId || 1,
    nextCreditEventId: counters.nextCreditEventId || 1,
    nextProductImageId: counters.nextProductImageId || 1,
    users,
    sessions,
    verificationCodes,
    brands,
    generations: [],
    creditEvents: [],
    productImages: [],
    imageJobs: [],
  };
}

function readLegacyBrandAssetTags(brandId) {
  if (tableExists("brand_asset_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM brand_asset_tags
      WHERE brand_id = ?
      ORDER BY position ASC
    `).all(brandId);
    if (rows.length) return rows.map((row) => row.tag);
  }

  if (hasColumn("brands", "asset_tags_json")) {
    const row = db.prepare("SELECT asset_tags_json FROM brands WHERE id = ?").get(brandId);
    return safeParseArray(row?.asset_tags_json);
  }

  return [];
}

function readLegacyAnalysisTrends(analysisId) {
  const rows = db.prepare(`
    SELECT *
    FROM analysis_trends
    WHERE analysis_id = ?
    ORDER BY snapshot_order ASC
  `).all(analysisId);

  return rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    title: row.title,
    category: row.category,
    summary: row.summary,
    score: row.score,
    tags: readLegacyAnalysisTrendTags(analysisId, row.id, row.tags_json),
    reason: row.reason,
    customPrompt: row.custom_prompt || "",
    ideas: readLegacyAnalysisTrendIdeas(analysisId, row.id),
  }));
}

function readLegacyAnalysisTrendTags(analysisId, trendId, legacyJson) {
  if (tableExists("analysis_trend_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM analysis_trend_tags
      WHERE analysis_id = ? AND trend_id = ?
      ORDER BY position ASC
    `).all(analysisId, trendId);
    if (rows.length) return rows.map((row) => row.tag);
  }
  return safeParseArray(legacyJson);
}

function readLegacyAnalysisTrendIdeas(analysisId, trendId) {
  const selectSql = hasColumn("analysis_trend_ideas", "analysis_id")
    ? "SELECT * FROM analysis_trend_ideas WHERE analysis_id = ? AND trend_id = ? ORDER BY idea_index ASC"
    : "SELECT * FROM analysis_trend_ideas WHERE trend_id = ? ORDER BY idea_index ASC";
  const rows = hasColumn("analysis_trend_ideas", "analysis_id")
    ? db.prepare(selectSql).all(analysisId, trendId)
    : db.prepare(selectSql).all(trendId);

  return rows.map((row) => ({
    title: row.title,
    summary: row.summary,
    angle: row.angle,
    brandFit: row.brand_fit,
    audience: row.audience,
    hook: row.hook,
    tags: readLegacyAnalysisIdeaTags(analysisId, trendId, row.idea_index, row.tags_json),
  }));
}

function readLegacyAnalysisIdeaTags(analysisId, trendId, ideaIndex, legacyJson) {
  if (tableExists("analysis_trend_idea_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM analysis_trend_idea_tags
      WHERE analysis_id = ? AND trend_id = ? AND idea_index = ?
      ORDER BY position ASC
    `).all(analysisId, trendId, ideaIndex);
    if (rows.length) return rows.map((row) => row.tag);
  }
  return safeParseArray(legacyJson);
}

function readLegacyCurrentTrends(brandId) {
  const rows = db.prepare(`
    SELECT *
    FROM current_trends
    WHERE brand_id = ?
    ORDER BY rank ASC, id ASC
  `).all(brandId);

  return rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    title: row.title,
    category: row.category,
    summary: row.summary,
    score: row.score,
    tags: readLegacyCurrentTrendTags(row.id, row.tags_json),
    reason: row.reason,
    customPrompt: row.custom_prompt || "",
    ideas: readLegacyCurrentTrendIdeas(row.id),
  }));
}

function readLegacyCurrentTrendTags(trendId, legacyJson) {
  if (tableExists("current_trend_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM current_trend_tags
      WHERE trend_id = ?
      ORDER BY position ASC
    `).all(trendId);
    if (rows.length) return rows.map((row) => row.tag);
  }
  return safeParseArray(legacyJson);
}

function readLegacyCurrentTrendIdeas(trendId) {
  return db.prepare(`
    SELECT *
    FROM current_trend_ideas
    WHERE trend_id = ?
    ORDER BY idea_index ASC
  `).all(trendId).map((row) => ({
    title: row.title,
    summary: row.summary,
    angle: row.angle,
    brandFit: row.brand_fit,
    audience: row.audience,
    hook: row.hook,
    tags: readLegacyCurrentIdeaTags(trendId, row.idea_index, row.tags_json),
  }));
}

function readLegacyCurrentIdeaTags(trendId, ideaIndex, legacyJson) {
  if (tableExists("current_trend_idea_tags")) {
    const rows = db.prepare(`
      SELECT tag
      FROM current_trend_idea_tags
      WHERE trend_id = ? AND idea_index = ?
      ORDER BY position ASC
    `).all(trendId, ideaIndex);
    if (rows.length) return rows.map((row) => row.tag);
  }
  return safeParseArray(legacyJson);
}

module.exports = {
  readStoreFromDbAnySchema,
  readStoreFromCurrentSchema,
  readIdeasForTrendRow,
  readStoreFromLegacySchema,
  readLegacyBrandAssetTags,
  readLegacyAnalysisTrends,
  readLegacyCurrentTrends,
};
