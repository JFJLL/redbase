import type { ApiErrorBody } from "@/shared/types/api";

/** Error thrown for non-2xx API responses. `message` carries the backend
 *  error text verbatim so views can surface the original copy. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null, fallbackMessage: string) {
    super(String(body?.error || fallbackMessage));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-serializable request body. */
  body?: unknown;
  /** Raw body (FormData etc.) — used instead of `body` when provided. */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | undefined | null>;
}

function buildUrl(path: string, query?: ApiRequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}${path.includes("?") ? "&" : "?"}${encoded}` : path;
}

/** Fetch wrapper for backend JSON APIs. Cookies ride along via same-origin
 *  credentials; API paths and semantics must match the legacy frontend. */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = "GET", body, rawBody, headers = {}, signal, query } = options;
  const requestHeaders: Record<string, string> = { ...headers };
  let requestBody: BodyInit | undefined = rawBody;
  if (requestBody === undefined && body !== undefined) {
    requestHeaders["Content-Type"] = requestHeaders["Content-Type"] || "application/json";
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(buildUrl(path, query), {
    method,
    headers: requestHeaders,
    body: requestBody,
    credentials: "same-origin",
    signal,
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const parsed = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    throw new ApiError(response.status, parsed as ApiErrorBody | null, `请求失败（${response.status}）`);
  }
  return parsed as T;
}

/** True when the error is a fetch abort — callers should swallow these. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** True when the backend rejected the session (401). */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
