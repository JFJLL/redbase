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

/** Remote http(s) URLs become proxy paths; relative URLs pass through unchanged. */
export function excellentImageSrc(
  value: unknown,
  imageIndex: number,
  params: ExcellentImageProxyParams,
): string {
  if (typeof value !== "string" || !value) return "";
  if (!isRemoteHttpUrl(value)) return value;
  return buildExcellentImageProxyPath(params.noteId || "", imageIndex, params);
}
