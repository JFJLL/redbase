import { defineStore } from "pinia";
import { apiFetch, isUnauthorized } from "@/shared/api/client";
import { notifyAuthReset } from "@/shared/composables/useAbortScope";
import type { OkResponse, SessionResponse, SessionUser } from "@/shared/types/api";

/** Session store shared by the workspace and admin apps. Backend endpoints and
 *  payload shapes must stay identical to the legacy frontend. */
export const useAuthStore = defineStore("auth", {
  state: () => ({
    user: null as SessionUser | null,
    sessionLoaded: false,
    sessionLoading: false,
  }),
  getters: {
    isLoggedIn: (state) => Boolean(state.user),
    isAdmin: (state) => Boolean(state.user?.isAdmin),
  },
  actions: {
    /** GET /api/session — 401 simply means "not logged in". */
    async loadSession(): Promise<SessionUser | null> {
      this.sessionLoading = true;
      try {
        const data = await apiFetch<SessionResponse>("/api/session");
        this.user = data.user;
        return this.user;
      } catch (error) {
        if (isUnauthorized(error)) {
          this.user = null;
          return null;
        }
        throw error;
      } finally {
        this.sessionLoading = false;
        this.sessionLoaded = true;
      }
    },

    async login(phone: string, password: string): Promise<SessionUser> {
      // Switching accounts must cancel requests started under the old session.
      notifyAuthReset();
      const data = await apiFetch<SessionResponse>("/api/auth/login", {
        method: "POST",
        body: { phone, password },
      });
      this.user = data.user;
      this.sessionLoaded = true;
      return data.user;
    },

    async register(payload: Record<string, unknown>): Promise<SessionUser> {
      notifyAuthReset();
      const data = await apiFetch<SessionResponse>("/api/auth/register", {
        method: "POST",
        body: payload,
      });
      this.user = data.user;
      this.sessionLoaded = true;
      return data.user;
    },

    async logout(): Promise<void> {
      notifyAuthReset();
      try {
        await apiFetch<OkResponse>("/api/auth/logout", { method: "POST" });
      } finally {
        this.user = null;
      }
    },

    /** Refresh session silently (e.g. after credits change). */
    async refreshUser(): Promise<void> {
      try {
        const data = await apiFetch<SessionResponse>("/api/session");
        this.user = data.user;
      } catch (error) {
        if (isUnauthorized(error)) {
          this.user = null;
          return;
        }
        throw error;
      }
    },

    /** Local session invalidation when any API answers 401. */
    handleUnauthorized(): void {
      notifyAuthReset();
      this.user = null;
    },
  },
});
