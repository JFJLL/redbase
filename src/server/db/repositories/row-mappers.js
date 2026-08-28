const { normalizeBrandLogo, safeParseArray, safeParseObject } = require("../snapshot-utils");

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    password: row.password,
    accountType: row.account_type || "customer",
    department: row.department || "",
    credits: Number(row.credits || 0),
    createdAt: row.created_at,
  };
}

function mapSessionRow(row) {
  if (!row) return null;
  return {
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
  };
}

function mapCreditEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    actionType: row.action_type,
    actionLabel: row.action_label,
    creditDelta: row.credit_delta,
    creditCost: row.credit_cost,
    createdAt: row.created_at,
    adminUserId: row.admin_user_id,
    adminUserName: row.admin_user_name || "",
    brandId: row.brand_id,
    brandName: row.brand_name || "",
    trendId: row.trend_id,
    trendTitle: row.trend_title || "",
    ideaTitle: row.idea_title || "",
    generationId: row.generation_id,
    channelLabel: row.channel_label || "",
    summary: row.summary || "",
    payload: safeParseObject(row.payload_json),
  };
}

function mapBrandRow(row) {
  if (!row) return null;
  return {
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
    profileType: row.profile_type === "personal" ? "personal" : "brand",
    contentPillars: safeParseArray(row.content_pillars_json),
    personaStyle: row.persona_style || "",
    materialCount: Number(row.material_count || 0),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    materials: [],
    analyses: [],
    trends: [],
  };
}

function mapGenerationRow(row) {
  if (!row) return null;
  return {
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
    visibilityStatus: row.visibility_status || "active",
    assetStatus: row.asset_status || "available",
    assetCount: Number(row.asset_count || 0),
    assetBytes: Number(row.asset_bytes || 0),
    assetsDeletedAt: row.assets_deleted_at || "",
    assetsDeleteError: row.assets_delete_error || "",
    updatedAt: row.updated_at || "",
  };
}

module.exports = {
  mapUserRow,
  mapSessionRow,
  mapCreditEventRow,
  mapBrandRow,
  mapGenerationRow,
};
