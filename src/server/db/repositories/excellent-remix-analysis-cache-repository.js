const { getDbProxy } = require("../connection");

const db = getDbProxy();

const CACHE_COLUMNS = `
  note_id, board_key, source_signature, analysis_version, analysis_mode,
  analysis_json, model_name, created_at, expires_at, last_error
`;

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "");
    return parsed == null ? fallback : parsed;
  } catch (_error) {
    return fallback;
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    noteId: String(row.note_id || ""),
    boardKey: String(row.board_key || ""),
    sourceSignature: String(row.source_signature || ""),
    analysisVersion: String(row.analysis_version || ""),
    analysisMode: String(row.analysis_mode || ""),
    analysis: parseJson(row.analysis_json, null),
    modelName: String(row.model_name || ""),
    createdAt: String(row.created_at || ""),
    expiresAt: String(row.expires_at || ""),
    lastError: String(row.last_error || ""),
  };
}

function findRemixAnalysisCache({ noteId, boardKey, sourceSignature, analysisVersion } = {}) {
  const row = db
    .prepare(
      `SELECT ${CACHE_COLUMNS}
       FROM excellent_content_remix_analysis_cache
       WHERE note_id = ? AND board_key = ? AND source_signature = ? AND analysis_version = ?`,
    )
    .get(
      String(noteId || ""),
      String(boardKey || ""),
      String(sourceSignature || ""),
      String(analysisVersion || ""),
    );
  return mapRow(row);
}

function upsertRemixAnalysisCache({
  noteId,
  boardKey,
  sourceSignature,
  analysisVersion,
  analysisMode,
  analysis,
  modelName = "",
  createdAt,
  expiresAt,
  lastError = "",
} = {}) {
  const now = new Date().toISOString();
  const safeNoteId = String(noteId || "").trim();
  const safeBoardKey = String(boardKey || "").trim();
  const safeSignature = String(sourceSignature || "").trim();
  const safeVersion = String(analysisVersion || "").trim();
  if (!safeNoteId || !safeBoardKey || !safeSignature || !safeVersion) {
    throw new Error("remix analysis cache requires noteId, boardKey, sourceSignature, analysisVersion");
  }
  db.prepare(
    `
    INSERT INTO excellent_content_remix_analysis_cache (
      note_id, board_key, source_signature, analysis_version, analysis_mode,
      analysis_json, model_name, created_at, expires_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(note_id, board_key, source_signature, analysis_version) DO UPDATE SET
      analysis_mode = excluded.analysis_mode,
      analysis_json = excluded.analysis_json,
      model_name = excluded.model_name,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at,
      last_error = excluded.last_error
  `,
  ).run(
    safeNoteId,
    safeBoardKey,
    safeSignature,
    safeVersion,
    String(analysisMode || "metadata_only"),
    JSON.stringify(analysis && typeof analysis === "object" ? analysis : {}),
    String(modelName || "").slice(0, 120),
    String(createdAt || now),
    String(expiresAt || now),
    String(lastError || "").slice(0, 500),
  );
  return findRemixAnalysisCache({
    noteId: safeNoteId,
    boardKey: safeBoardKey,
    sourceSignature: safeSignature,
    analysisVersion: safeVersion,
  });
}

/**
 * Record failure without overwriting a successful analysis_json payload.
 */
function recordRemixAnalysisCacheError({
  noteId,
  boardKey,
  sourceSignature,
  analysisVersion,
  lastError = "",
} = {}) {
  const existing = findRemixAnalysisCache({ noteId, boardKey, sourceSignature, analysisVersion });
  if (!existing) return null;
  if (existing.analysis && typeof existing.analysis === "object") {
    db.prepare(
      `
      UPDATE excellent_content_remix_analysis_cache
      SET last_error = ?
      WHERE note_id = ? AND board_key = ? AND source_signature = ? AND analysis_version = ?
    `,
    ).run(
      String(lastError || "").slice(0, 500),
      String(noteId || ""),
      String(boardKey || ""),
      String(sourceSignature || ""),
      String(analysisVersion || ""),
    );
    return findRemixAnalysisCache({ noteId, boardKey, sourceSignature, analysisVersion });
  }
  return existing;
}

module.exports = {
  findRemixAnalysisCache,
  upsertRemixAnalysisCache,
  recordRemixAnalysisCacheError,
};
