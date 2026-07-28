/**
 * API helpers for excellent remix (analysis / directions / fusion / generation).
 * requestFn is injected so tests can stub transport.
 */

// Billing endpoints require a server-recognized requestId ([a-zA-Z0-9_-]{8,100}).
function ensureBillingRequestId(body) {
  const payload = { ...(body || {}) };
  if (!payload.requestId) {
    payload.requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
  return payload;
}

export async function fetchRemixAnalysis(requestFn, noteId, body) {
  return requestFn(`/api/excellent-contents/${encodeURIComponent(noteId)}/remix-analysis`, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}

export async function fetchContentDirections(requestFn, noteId, body) {
  return requestFn(`/api/excellent-contents/${encodeURIComponent(noteId)}/content-directions`, {
    method: "POST",
    body: JSON.stringify(ensureBillingRequestId(body)),
  });
}

export async function fetchRecommendTrends(requestFn, noteId, body) {
  return requestFn(`/api/excellent-contents/${encodeURIComponent(noteId)}/recommend-trends`, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}

export async function fetchFusionPlan(requestFn, noteId, body) {
  return requestFn(`/api/excellent-contents/${encodeURIComponent(noteId)}/fusion-plan`, {
    method: "POST",
    body: JSON.stringify(ensureBillingRequestId(body)),
  });
}

export async function fetchBrandRemixIdeas(requestFn, brandId) {
  return requestFn(`/api/brands/${Number(brandId)}/excellent-remix-ideas`);
}

export async function fetchBrandProductImages(requestFn, brandId) {
  return requestFn(`/api/product-images?brandId=${Number(brandId)}&includeUnassigned=1`);
}

export async function claimProductImageToBrand(requestFn, imageId, brandId) {
  return requestFn(`/api/product-images/${Number(imageId)}/claim`, {
    method: "POST",
    body: JSON.stringify({ brandId: Number(brandId) }),
  });
}

export async function previewExcellentRemix(requestFn, brandId, body) {
  return requestFn(`/api/brands/${Number(brandId)}/excellent-remix-preview`, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}

export async function generateExcellentRemixSlide(requestFn, brandId, slideIndex, body) {
  return requestFn(`/api/brands/${Number(brandId)}/excellent-remix/slides/${Number(slideIndex)}`, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}

export async function completeExcellentRemix(requestFn, brandId, body) {
  return requestFn(`/api/brands/${Number(brandId)}/excellent-remix/complete`, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}
