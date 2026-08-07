import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import RegisterView from "../views/RegisterView.vue";

const RouteStub = { template: "<div />" };

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: RouteStub },
      { path: "/login", name: "login", component: RouteStub },
      { path: "/register", name: "register", component: RouteStub },
      { path: "/brands", name: "brands", component: RouteStub },
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

describe("RegisterView", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mountView() {
    const router = makeRouter();
    router.push("/register");
    await router.isReady();
    const wrapper = mount(RegisterView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, router };
  }

  it("registers with password only (no SMS code) and navigates to brands", async () => {
    const fetchMock = stubFetch({
      "GET /api/auth/feishu/apps": () => jsonResponse(200, { apps: [] }),
      "POST /api/auth/register": () => jsonResponse(201, { user: { id: "u9", name: "小红" } }),
    });
    const { wrapper, router } = await mountView();
    const push = vi.spyOn(router, "push");

    await wrapper.find("input[name=phone]").setValue("13800000000");
    await wrapper.find("input[name=name]").setValue("小红");
    await wrapper.find("input[name=password]").setValue("secret66");
    expect(wrapper.find("input[name=code]").exists()).toBe(false);
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    const call = fetchMock.mock.calls.find(([url]) => String(url) === "/api/auth/register");
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      phone: "13800000000",
      name: "小红",
      password: "secret66",
    });
    expect(push).toHaveBeenCalledWith({ name: "brands" });
  });

  it("shows backend register errors verbatim", async () => {
    stubFetch({
      "GET /api/auth/feishu/apps": () => jsonResponse(200, { apps: [] }),
      "POST /api/auth/register": () => jsonResponse(409, { error: "该手机号已注册" }),
    });
    const { wrapper } = await mountView();

    await wrapper.find("input[name=phone]").setValue("13800000000");
    await wrapper.find("input[name=name]").setValue("小红");
    await wrapper.find("input[name=password]").setValue("secret66");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find(".form-error").text()).toBe("该手机号已注册");
  });
});
