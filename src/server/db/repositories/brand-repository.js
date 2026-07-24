const { getDbProxy } = require("../connection");
const {
  groupTrendRows,
  flattenTrendBuckets,
  safeParseArray,
  safeParseObject,
} = require("../snapshot-utils");
const { readIdeasForTrendRow } = require("../legacy-readers");
const { allocateCounter, runTransaction } = require("./core-repository");
const { mapCreatorMaterialRow } = require("./creator-material-repository");
const { mapBrandRow } = require("./row-mappers");

const db = getDbProxy();

function getBrandsBySql(sql, params = []) {
  const brands = db.prepare(sql).all(...params).map(mapBrandRow);
  hydrateBrandContent(brands);
  return brands;
}

function listBrandsByOwner(ownerUserId) {
  return getBrandsBySql(
    `SELECT id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base,
            logo_json, asset_tags_json, profile_type, content_pillars_json, persona_style
     FROM brands WHERE owner_user_id = ? ORDER BY id DESC`,
    [Number(ownerUserId)],
  );
}

function listBrandSummariesByOwner(ownerUserId) {
  return db.prepare(
    `SELECT
       b.id,
       b.owner_user_id,
       b.name,
       b.industry,
       b.audience,
       b.description,
       b.logo_json,
       b.asset_tags_json,
       b.profile_type,
       b.content_pillars_json,
       b.persona_style,
       (
         SELECT COUNT(*)
         FROM trends t
         WHERE t.brand_id = b.id AND t.scope = 'current'
       ) AS trend_count,
       (
         SELECT COUNT(*)
         FROM analyses a
         WHERE a.brand_id = b.id
       ) AS analysis_count,
       (
         SELECT COUNT(*)
         FROM creator_materials m
         WHERE m.brand_id = b.id AND m.owner_user_id = b.owner_user_id
       ) AS material_count
     FROM brands b
     WHERE b.owner_user_id = ?
     ORDER BY b.id DESC`,
  )
    .all(Number(ownerUserId))
    .map((row) => ({
      ...mapBrandRow({
        id: row.id,
        owner_user_id: row.owner_user_id,
        name: row.name,
        industry: row.industry,
        audience: row.audience,
        description: row.description,
        product: "",
        goal: "",
        knowledge_base: "",
        logo_json: row.logo_json,
        asset_tags_json: row.asset_tags_json,
        profile_type: row.profile_type,
        content_pillars_json: row.content_pillars_json,
        persona_style: row.persona_style,
        material_count: row.material_count,
      }),
      trendCount: Number(row.trend_count || 0),
      analysisCount: Number(row.analysis_count || 0),
    }));
}

function listAllBrands() {
  return getBrandsBySql(`
    SELECT id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base,
           logo_json, asset_tags_json, profile_type, content_pillars_json, persona_style
    FROM brands
    ORDER BY id DESC
  `);
}

function findBrandByOwner(brandId, ownerUserId) {
  return getBrandsBySql(
    `SELECT id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base,
            logo_json, asset_tags_json, profile_type, content_pillars_json, persona_style
     FROM brands WHERE id = ? AND owner_user_id = ?`,
    [Number(brandId), Number(ownerUserId)],
  )[0] || null;
}

function findBrandById(brandId) {
  return getBrandsBySql(
    `SELECT id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base,
            logo_json, asset_tags_json, profile_type, content_pillars_json, persona_style
     FROM brands WHERE id = ?`,
    [Number(brandId)],
  )[0] || null;
}

function hydrateBrandContent(brands) {
  if (!brands.length) return;
  const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
  const ids = brands.map((brand) => brand.id);
  const placeholders = ids.map(() => "?").join(",");
  const analysisMap = new Map();
  const materialRows = db.prepare(`
    SELECT id, owner_user_id, brand_id, kind, title, content, tags_json, source_date, created_at, updated_at
    FROM creator_materials
    WHERE brand_id IN (${placeholders})
    ORDER BY updated_at DESC, id DESC
  `).all(...ids);
  for (const row of materialRows) {
    const brand = brandMap.get(row.brand_id);
    if (!brand || brand.profileType !== "personal") continue;
    brand.materials.push(mapCreatorMaterialRow(row));
    brand.materialCount = brand.materials.length;
  }

  const analysisRows = db.prepare(`
    SELECT id, brand_id, name, timestamp, brand_brief_json, position
    FROM analyses
    WHERE brand_id IN (${placeholders})
    ORDER BY brand_id DESC, position ASC
  `).all(...ids);

  for (const row of analysisRows) {
    const brand = brandMap.get(row.brand_id);
    if (!brand) continue;
    const analysis = {
      id: row.id,
      name: row.name,
      timestamp: row.timestamp,
      brandBrief: safeParseObject(row.brand_brief_json),
      trendSnapshot: [],
    };
    brand.analyses.push(analysis);
    analysisMap.set(row.id, analysis);
  }

  const trendRows = db.prepare(`
    SELECT row_id, trend_id, stable_key, brand_id, analysis_id, scope, bucket_key, bucket_title, bucket_description, rank, title, category, summary, score, reason, custom_prompt, system_prompt, tags_json, evidence_ids_json, evidence_snapshot_json
    FROM trends
    WHERE brand_id IN (${placeholders})
    ORDER BY brand_id DESC, scope ASC, analysis_id ASC, bucket_key ASC, position ASC
  `).all(...ids);

  for (const row of trendRows) {
    const trend = {
      id: row.trend_id,
      stableKey: row.stable_key || "",
      bucketKey: row.bucket_key,
      bucketTitle: row.bucket_title,
      bucketDescription: row.bucket_description,
      rank: row.rank,
      title: row.title,
      category: row.category,
      summary: row.summary,
      score: row.score,
      tags: safeParseArray(row.tags_json),
      evidenceIds: safeParseArray(row.evidence_ids_json),
      evidence: safeParseArray(row.evidence_snapshot_json),
      reason: row.reason,
      customPrompt: row.custom_prompt || "",
      ideas: readIdeasForTrendRow(row.row_id),
    };

    if (row.scope === "current") {
      const brand = brandMap.get(row.brand_id);
      if (brand) groupTrendRows([trend], brand.trends);
      continue;
    }

    const analysis = analysisMap.get(row.analysis_id);
    if (analysis) groupTrendRows([trend], analysis.trendSnapshot);
  }
}

function insertBrand(input) {
  return runTransaction(() => {
    const brandId = input.id ?? allocateCounter("nextBrandId", 1);
    db.prepare(`
      INSERT INTO brands (
        id, owner_user_id, name, industry, audience, description, product, goal, knowledge_base,
        logo_json, asset_tags_json, profile_type, content_pillars_json, persona_style
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      brandId,
      input.ownerUserId,
      input.name,
      input.industry,
      input.audience,
      input.description,
      input.product,
      input.goal,
      input.knowledgeBase || "",
      JSON.stringify(input.logo || {}),
      JSON.stringify(Array.isArray(input.assetTags) ? input.assetTags : []),
      input.profileType === "personal" ? "personal" : "brand",
      JSON.stringify(Array.isArray(input.contentPillars) ? input.contentPillars : []),
      input.personaStyle || "",
    );
    return findBrandById(brandId);
  });
}

function updateBrandCore(brand) {
  db.prepare(`
    UPDATE brands SET
      name = ?,
      industry = ?,
      audience = ?,
      description = ?,
      product = ?,
      goal = ?,
      knowledge_base = ?,
      logo_json = ?,
      asset_tags_json = ?,
      profile_type = ?,
      content_pillars_json = ?,
      persona_style = ?
    WHERE id = ? AND owner_user_id = ?
  `).run(
    brand.name,
    brand.industry,
    brand.audience,
    brand.description,
    brand.product,
    brand.goal,
    brand.knowledgeBase || "",
    JSON.stringify(brand.logo || {}),
    JSON.stringify(Array.isArray(brand.assetTags) ? brand.assetTags : []),
    brand.profileType === "personal" ? "personal" : "brand",
    JSON.stringify(Array.isArray(brand.contentPillars) ? brand.contentPillars : []),
    brand.personaStyle || "",
    brand.id,
    brand.ownerUserId,
  );
}

function updateBrand(brand) {
  updateBrandCore(brand);
  return findBrandById(brand.id);
}

function replaceBrandContent(brand) {
  db.prepare("DELETE FROM ideas WHERE trend_row_id IN (SELECT row_id FROM trends WHERE brand_id = ?)").run(brand.id);
  db.prepare("DELETE FROM trends WHERE brand_id = ?").run(brand.id);
  db.prepare("DELETE FROM analyses WHERE brand_id = ?").run(brand.id);
  insertBrandContent(brand);
}

function upsertBrandFull(brand) {
  return runTransaction(() => {
    updateBrandCore(brand);
    replaceBrandContent(brand);
    return findBrandById(brand.id);
  });
}

function updateCurrentTrendIdeaContentAssets(brandId, ownerUserId, trendId, ideaIndex, contentAssets) {
  const result = db.prepare(`
    UPDATE ideas
    SET content_assets_json = ?
    WHERE idea_index = ?
      AND trend_row_id = (
        SELECT t.row_id
        FROM trends t
        INNER JOIN brands b ON b.id = t.brand_id
        WHERE t.brand_id = ?
          AND b.owner_user_id = ?
          AND t.scope = 'current'
          AND t.trend_id = ?
        LIMIT 1
      )
  `).run(
    JSON.stringify(safeParseObject(JSON.stringify(contentAssets || {}))),
    Number(ideaIndex),
    Number(brandId),
    Number(ownerUserId),
    Number(trendId),
  );
  return result.changes === 1;
}

function deleteBrandById(brandId) {
  return runTransaction(() => {
    db.prepare("DELETE FROM creator_materials WHERE brand_id = ?").run(Number(brandId));
    db.prepare("DELETE FROM ideas WHERE trend_row_id IN (SELECT row_id FROM trends WHERE brand_id = ?)").run(Number(brandId));
    db.prepare("DELETE FROM trends WHERE brand_id = ?").run(Number(brandId));
    db.prepare("DELETE FROM analyses WHERE brand_id = ?").run(Number(brandId));
    db.prepare("DELETE FROM brands WHERE id = ?").run(Number(brandId));
  });
}

function insertBrandContent(brand) {
  for (const [analysisPosition, analysis] of (brand.analyses || []).entries()) {
    db.prepare("INSERT INTO analyses (id, brand_id, name, timestamp, brand_brief_json, position) VALUES (?, ?, ?, ?, ?, ?)").run(
      analysis.id,
      brand.id,
      analysis.name,
      analysis.timestamp,
      JSON.stringify(safeParseObject(JSON.stringify(analysis.brandBrief || {}))),
      analysisPosition,
    );
    insertTrendBuckets(brand.id, analysis.id, "snapshot", analysis.trendSnapshot || []);
  }
  insertTrendBuckets(brand.id, null, "current", brand.trends || []);
}

function insertTrendBuckets(brandId, analysisId, scope, buckets) {
  const insertTrend = db.prepare(`
    INSERT INTO trends (
      trend_id, stable_key, brand_id, analysis_id, scope, bucket_key, bucket_title, bucket_description, rank, title, category, summary, score, reason, custom_prompt, system_prompt, tags_json, evidence_ids_json, evidence_snapshot_json, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertIdea = db.prepare(`
    INSERT INTO ideas (trend_row_id, idea_index, title, summary, angle, brand_fit, audience, hook, tags_json, content_assets_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [trendPosition, trend] of flattenTrendBuckets(buckets).entries()) {
    const trendResult = insertTrend.run(
      trend.id,
      trend.stableKey || "",
      brandId,
      analysisId,
      scope,
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
      "",
      JSON.stringify(Array.isArray(trend.tags) ? trend.tags : []),
      JSON.stringify(Array.isArray(trend.evidenceIds) ? trend.evidenceIds : []),
      JSON.stringify(Array.isArray(trend.evidence) ? trend.evidence : []),
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
        JSON.stringify(safeParseObject(JSON.stringify(idea.contentAssets || {}))),
      );
    }
  }
}

function allocateAnalysisAndTrendBase() {
  return runTransaction(() => {
    const analysisId = allocateCounter("nextAnalysisId", 9001);
    const trendBase = allocateCounter("nextTrendId", 100);
    db.prepare(`
      INSERT INTO counters (name, value) VALUES ('nextTrendId', ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value
    `).run(trendBase + 600);
    return { analysisId, trendBase };
  });
}

module.exports = {
  listBrandsByOwner,
  listBrandSummariesByOwner,
  listAllBrands,
  findBrandByOwner,
  findBrandById,
  insertBrand,
  updateBrand,
  upsertBrandFull,
  updateCurrentTrendIdeaContentAssets,
  deleteBrandById,
  allocateAnalysisAndTrendBase,
};
