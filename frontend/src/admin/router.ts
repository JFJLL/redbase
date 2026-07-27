import { createRouter, createWebHistory, type Router } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";

// Frozen admin route table (orchestrator-owned). The Content agent implements
// the admin views referenced below and MUST NOT edit this file.
export function createAdminRouter(): Router {
  const router = createRouter({
    history: createWebHistory("/admin/"),
    routes: [
      {
        path: "/",
        name: "admin-dashboard",
        meta: { requiresAdmin: true },
        component: () => import("@/features/admin/views/AdminDashboardView.vue"),
      },
      {
        path: "/:pathMatch(.*)*",
        redirect: { name: "admin-dashboard" },
      },
    ],
  });

  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    if (!auth.sessionLoaded && !auth.sessionLoading) {
      try {
        await auth.loadSession();
      } catch {
        // Network failure: the view surfaces its own error state.
      }
    }
    if (to.meta.requiresAdmin && !auth.isAdmin) {
      // Non-admin sessions bounce to the workspace login, same as the legacy
      // admin page which requires an admin session cookie.
      window.location.href = "/app/login";
      return false;
    }
    return true;
  });

  return router;
}
