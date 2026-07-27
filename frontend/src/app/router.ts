import { createRouter, createWebHistory, type Router } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";

// Frozen route table (orchestrator-owned). Business agents implement the view
// files referenced below and MUST NOT edit this file. Every business page is a
// dynamic import so entering one tab never downloads another tab's chunk.
export function createAppRouter(): Router {
  const router = createRouter({
    history: createWebHistory("/app/"),
    routes: [
      {
        path: "/login",
        name: "login",
        meta: { guestOnly: true },
        component: () => import("@/features/auth/views/LoginView.vue"),
      },
      {
        path: "/register",
        name: "register",
        meta: { guestOnly: true },
        component: () => import("@/features/auth/views/RegisterView.vue"),
      },
      {
        path: "/",
        component: () => import("./views/WorkspaceShell.vue"),
        meta: { requiresAuth: true },
        children: [
          { path: "", redirect: { name: "brands" } },
          {
            path: "home",
            name: "home",
            component: () => import("./views/WorkspaceHomeView.vue"),
          },
          {
            path: "brands",
            name: "brands",
            component: () => import("@/features/brands/views/BrandsView.vue"),
          },
          {
            path: "personal",
            name: "personal",
            component: () => import("@/features/personal/views/PersonalIpView.vue"),
          },
          {
            path: "trends",
            name: "trends",
            component: () => import("@/features/trends/views/TrendsView.vue"),
          },
          {
            path: "ideas",
            name: "ideas",
            component: () => import("@/features/ideas/views/IdeasView.vue"),
          },
          {
            path: "excellent",
            name: "excellent",
            component: () => import("@/features/excellent/views/ExcellentView.vue"),
          },
          {
            path: "generation",
            name: "generation",
            component: () => import("@/features/generation/views/GenerationView.vue"),
          },
          {
            path: "history",
            name: "history",
            component: () => import("@/features/history/views/HistoryView.vue"),
          },
        ],
      },
      {
        path: "/:pathMatch(.*)*",
        name: "not-found",
        component: () => import("./views/NotFoundView.vue"),
      },
    ],
  });

  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    if (!auth.sessionLoaded && !auth.sessionLoading) {
      try {
        await auth.loadSession();
      } catch {
        // Network failure: let the target view surface its own error state.
      }
    }
    if (to.meta.requiresAuth && !auth.isLoggedIn) {
      return { name: "login", query: to.fullPath === "/" ? {} : { redirect: to.fullPath } };
    }
    if (to.meta.guestOnly && auth.isLoggedIn) {
      const redirect = typeof to.query.redirect === "string" ? to.query.redirect : "";
      return redirect ? { path: redirect } : { name: "brands" };
    }
    return true;
  });

  return router;
}
