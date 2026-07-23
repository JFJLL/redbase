/**
 * API helpers for excellent remix (analysis / directions / fusion / generation).
 * requestFn is injected so tests can stub transport.
 */

export async function fetchRemixAnalysis(requestFn, noteId, body) {
  return requestFn(`/api/excellent-contents/${encodeURIComponent(noteId)}/remix-analysis`, {
    method: "POST",
    body: JSON.stringify(body || {}),
  });
}

export async function fetchContentDirections(requestFn, noteId, body) {
  return requestFn(`/api/excellent-contents/${encodeURIComponent(noteId)}/content-directions`, {
    method: "POST",
    body: JSON.stringify(body || {}),
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
    body: JSON.stringify(body || {}),
  });
}

export async function fetchBrandRemixIdeas(requestFn, brandId) {
  return requestFn(`/api/brands/${Number(brandId)}/excellent-remix-ideas`);
}

export async function fetchBrandProductImages(requestFn, brandId) {
  return requestFn(`/api/product-images?brandId=${Number(brandId)}`);
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
