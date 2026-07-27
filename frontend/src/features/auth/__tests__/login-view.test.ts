import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import LoginView from "../views/LoginView.vue";

const RouteStub = { template: "<div />" };

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: RouteStub },
      { path: "/login", name: "login", component: RouteStub },
      { path: "/register", name: "register", component: RouteStub },
      { path: "/brands", name: "brands", component: RouteStub },
      { path: "/personal", name: "personal", component: RouteStub },
      { path: "/trends", name: "trends", component: RouteStub },
    ],
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

type FetchHandler = (init?: RequestInit) => Response;

/** fetch stub keyed by "METHOD url"; unmatched calls fail the test. */
function stubFetch(handlers: Record<string, FetchHandler>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method || "GET"} ${String(input)}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("LoginView", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mountAt(path: string) {
    const router = makeRouter();
    router.push(path);
    await router.isReady();
    const wrapper = mount(LoginView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, router };
  }

  it("logs in with phone + password and navigates to brands", async () => {
    const fetchMock = stubFetch({
      "GET /api/auth/feishu/apps": () => jsonResponse(200, { apps: [] }),
      "POST /api/auth/login": () => jsonResponse(200, { user: { id: "u1", phone: "13800000000" } }),
    });
    const { wrapper, router } = await mountAt("/login");
    const push = vi.spyOn(router, "push");

    await wrapper.find("input[name=phone]").setValue("13800000000");
    await wrapper.find("input[name=password]").setValue("secret66");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const loginCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/auth/login");
    expect(loginCall).toBeTruthy();
    expect(JSON.parse(String((loginCall![1] as RequestInit).body))).toEqual({
      phone: "13800000000",
      password: "secret66",
    });
    expect(push).toHaveBeenCalledWith({ name: "brands" });
  });

  it("honors the redirect query after login", async () => {
    stubFetch({
      "GET /api/auth/feishu/apps": () => jsonResponse(200, { apps: [] }),
      "POST /api/auth/login": () => jsonResponse(200, { user: { id: "u1" } }),
    });
    const { wrapper, router } = await mountAt("/login?redirect=/personal");
    const push = vi.spyOn(router, "push");

    await wrapper.find("input[name=phone]").setValue("13800000000");
    await wrapper.find("input[name=password]").setValue("secret66");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(push).toHaveBeenCalledWith("/personal");
  });

  it("shows the backend error text verbatim on failure", async () => {
    stubFetch({
      "GET /api/auth/feishu/apps": () => jsonResponse(200, { apps: [] }),
      "POST /api/auth/login": () => jsonResponse(401, { error: "手机号或密码错误" }),
    });
    const { wrapper } = await mountAt("/login");

    await wrapper.find("input[name=phone]").setValue("13800000000");
    await wrapper.find("input[name=password]").setValue("wrong");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find(".form-error").text()).toBe("手机号或密码错误");
  });

  it("lists Feishu tenants returned by the backend", async () => {
    stubFetch({
      "GET /api/auth/feishu/apps": () =>
        jsonResponse(200, { apps: [{ key: "main", name: "RedBase 企业" }] }),
    });
    const { wrapper } = await mountAt("/login");

    const feishu = wrapper.find("[data-testid=feishu-login]");
    expect(feishu.exists()).toBe(true);
    expect(feishu.text()).toContain("使用飞书登录");
  });
});
