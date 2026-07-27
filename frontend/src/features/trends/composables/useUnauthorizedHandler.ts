// 401 统一处理：清理本地会话并跳转登录页（任务约定行为）。
import { useRouter } from "vue-router";
import { isUnauthorized } from "@/shared/api/client";
import { useAuthStore } from "@/shared/stores/auth";

export function useUnauthorizedHandler(): (error: unknown) => boolean {
  const auth = useAuthStore();
  const router = useRouter();
  return (error: unknown): boolean => {
    if (!isUnauthorized(error)) return false;
    auth.handleUnauthorized();
    void router.push({ name: "login" });
    return true;
  };
}
