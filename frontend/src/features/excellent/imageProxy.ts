/**
 * Client-side image URL helper for the excellent-content feature.
 *
 * The backend rewrites cached remote image URLs to same-origin SSRF-safe proxy
 * paths; this helper mirrors that contract so the view can also normalize any
 * legacy/remote URL that slips through (e.g. older cache shapes) and so the
 * relative URLs are always left untouched.
 */

export interface ExcellentImageProxyParams {
  noteId?: string;
  board?: string;
  contentSource?: string;
  categoryPath?: string;
  industryPath?: string;
}

export function isRemoteHttpUrl(value: unknown): boolean {
  return /^https?:\/\//i.test(String(value || "").trim());
}

export function buildExcellentImageProxyPath(
  noteId: string,
  imageIndex: number,
  params: ExcellentImageProxyParams = {},
): string {
  const query = new URLSearchParams();
  if (params.board) query.set("board", params.board);
  if (params.contentSource) query.set("contentSource", params.contentSource);
  if (params.categoryPath) query.set("categoryPath", params.categoryPath);
  if (params.industryPath) query.set("industryPath", params.industryPath);
  const queryString = query.toString();
  return `/api/excellent-contents/${encodeURIComponent(String(noteId || ""))}/images/${Number(imageIndex)}/file${
    queryString ? `?${queryString}` : ""
  }`;
}

/**
 * Preserve the upstream-provided image URL. Excellent-content cards are
 * display-only, so the browser must load the original platform image directly
 * instead of routing it through this application's image endpoint.
 */
export function excellentImageSrc(
  value: unknown,
  _imageIndex: number,
  _params: ExcellentImageProxyParams,
): string {
  return typeof value === "string" ? value : "";
}
