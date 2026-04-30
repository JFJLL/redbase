const { safeParseObject } = require("../snapshot-utils");

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

module.exports = {
  mapUserRow,
  mapSessionRow,
  mapCreditEventRow,
};
