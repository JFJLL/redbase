import { apiFetch } from "@/shared/api/client";

// Auth helper API beyond the shared session store. Endpoints mirror
// src/server/api/auth-routes.js.

export interface SendCodeResponse {
  message: string;
  demoCode?: string;
}

export interface FeishuApp {
  key: string;
  name: string;
}

/** POST /api/auth/send-code — backend returns the notice text (and a demo
 *  code in environments without an SMS provider). */
export function sendCode(phone: string): Promise<SendCodeResponse> {
  return apiFetch<SendCodeResponse>("/api/auth/send-code", { method: "POST", body: { phone } });
}

/** GET /api/auth/feishu/apps — configured Feishu tenants for SSO login. */
export function fetchFeishuApps(signal?: AbortSignal): Promise<{ apps: FeishuApp[] }> {
  return apiFetch<{ apps: FeishuApp[] }>("/api/auth/feishu/apps", { signal });
}

/** Browser navigation target starting the Feishu OAuth flow. */
export function feishuStartUrl(appKey: string, next = "/app/brands"): string {
  const params = new URLSearchParams({ app: appKey, next });
  return `/api/auth/feishu/start?${params.toString()}`;
}
