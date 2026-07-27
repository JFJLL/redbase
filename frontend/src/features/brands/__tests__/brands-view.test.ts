import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import BrandsView from "../views/BrandsView.vue";

const RouteStub = { template: "<div />" };

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: RouteStub },
      { path: "/login", name: "login", component: RouteStub },
      { path: "/brands", name: "brands", component: RouteStub },
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

const brandFixture = {
  id: 7,
  ownerUserId: 1,
  name: "山茶护肤",
  industry: "美妆",
  audience: "25-35岁都市女性",
  description: "以山茶花油为核心成分的国货护肤品牌。",
  profileType: "brand",
  contentPillars: [],
  personaStyle: "",
  materialCount: 0,
  logo: null,
  assetTags: [],
  trendCount: 3,
  analysisCount: 2,
};

const personalFixture = {
  ...brandFixture,
  id: 8,
  name: "阿宁聊创业",
  profileType: "personal",
};

describe("BrandsView", () => {
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
    router.push("/brands");
    await router.isReady();
    const wrapper = mount(BrandsView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, router };
  }

  it("renders brand cards with the real summary fields and hides personal profiles", async () => {
    stubFetch({
      "GET /api/brands?summary=1": () =>
        jsonResponse(200, { brands: [brandFixture, personalFixture] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
    });
    const { wrapper } = await mountView();

    const cards = wrapper.findAll("[data-testid=brand-card]");
    expect(cards).toHaveLength(1);
    const text = cards[0]!.text();
    expect(text).toContain("山茶护肤");
    expect(text).toContain("美妆");
    expect(text).toContain("目标受众：25-35岁都市女性");
    expect(text).toContain("以山茶花油为核心成分的国货护肤品牌。");
    expect(text).toContain("趋势 3 条 · 分析 2 次");
    expect(wrapper.text()).not.toContain("阿宁聊创业");
  });

  it("shows the legacy empty-state copy when there are no brands", async () => {
    stubFetch({
      "GET /api/brands?summary=1": () => jsonResponse(200, { brands: [personalFixture] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
    });
    const { wrapper } = await mountView();

    expect(wrapper.text()).toContain(
      "你还没有品牌档案。登录后先新增品牌，就可以开始热点分析和内容选题。",
    );
  });

  it("submits the create-brand payload with the legacy field names", async () => {
    const fetchMock = stubFetch({
      "GET /api/brands?summary=1": () => jsonResponse(200, { brands: [] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
      "POST /api/brands": () =>
        jsonResponse(201, { brand: { ...brandFixture, product: "山茶花精华油", goal: "提升品牌知名度", knowledgeBase: "", analyses: [], trends: [] } }),
    });
    const { wrapper } = await mountView();

    const addBtn = wrapper.findAll("button").find((button) => button.text() === "新增品牌");
    await addBtn!.trigger("click");

    await wrapper.find("input[name=name]").setValue("山茶护肤");
    await wrapper.find("input[name=industry]").setValue("美妆");
    await wrapper.find("input[name=audience]").setValue("25-35岁都市女性");
    await wrapper.find("textarea[name=description]").setValue("以山茶花油为核心成分的国货护肤品牌。");
    await wrapper.find("textarea[name=product]").setValue("山茶花精华油");
    await wrapper.find("textarea[name=knowledgeBase]").setValue("成分：山茶花油");
    await wrapper.find("textarea[name=goal]").setValue("提升品牌知名度");
    await wrapper.find("form.brand-form").trigger("submit");
    await flushPromises();

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/brands" && (init as RequestInit)?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String((createCall![1] as RequestInit).body))).toEqual({
      profileType: "brand",
      name: "山茶护肤",
      industry: "美妆",
      audience: "25-35岁都市女性",
      description: "以山茶花油为核心成分的国货护肤品牌。",
      product: "山茶花精华油",
      knowledgeBase: "成分：山茶花油",
      goal: "提升品牌知名度",
      contentPillars: "",
      personaStyle: "",
    });
  });

  it("handles 401 by resetting the session and routing to login", async () => {
    stubFetch({
      "GET /api/brands?summary=1": () => jsonResponse(401, { error: "登录状态已失效" }),
      "GET /api/history": () => jsonResponse(401, { error: "登录状态已失效" }),
    });
    const auth = useAuthStore();
    auth.user = { id: "u1" };
    const handleUnauthorized = vi.spyOn(auth, "handleUnauthorized");

    const { router } = await mountView();
    await flushPromises();

    expect(handleUnauthorized).toHaveBeenCalled();
    expect(router.currentRoute.value.name).toBe("login");
  });
});
