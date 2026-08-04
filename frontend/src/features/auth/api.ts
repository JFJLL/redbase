import { apiFetch } from "@/shared/api/client";

// Auth helper API beyond the shared session store. Endpoints mirror
// src/server/api/auth-routes.js.

export interface SendCodeResponse {
  message: string;
  demoCode?: string;
}

export type VerificationPurpose = "register" | "reset_password";

export interface FeishuApp {
  key: string;
  name: string;
}

/** POST /api/auth/send-code — backend returns the notice text (and a demo
 *  code only in test environments with the fake provider explicitly enabled). */
export function sendCode(phone: string, purpose: VerificationPurpose = "register"): Promise<SendCodeResponse> {
  return apiFetch<SendCodeResponse>("/api/auth/send-code", { method: "POST", body: { phone, purpose } });
}

/** POST /api/auth/reset-password/send-code — unified response against enumeration. */
export function sendResetPasswordCode(phone: string): Promise<SendCodeResponse> {
  return apiFetch<SendCodeResponse>("/api/auth/reset-password/send-code", {
    method: "POST",
    body: { phone },
  });
}

/** POST /api/auth/reset-password — verify code, change password, kill sessions. */
export function resetPassword(phone: string, code: string, password: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>("/api/auth/reset-password", {
    method: "POST",
    body: { phone, code, password },
  });
}

/** GET /api/auth/feishu/apps — configured Feishu tenants for SSO login. */
export function fetchFeishuApps(signal?: AbortSignal): Promise<{ apps: FeishuApp[] }> {
  return apiFetch<{ apps: FeishuApp[] }>("/api/auth/feishu/apps", { signal });
}

/** Browser navigation target starting the Feishu OAuth flow. */
export function feishuStartUrl(appKey: string): string {
  return `/api/auth/feishu/start?app=${encodeURIComponent(appKey)}`;
}
