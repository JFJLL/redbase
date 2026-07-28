import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import PersonalIpView from "../views/PersonalIpView.vue";

const RouteStub = { template: "<div />" };

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: RouteStub },
      { path: "/login", name: "login", component: RouteStub },
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

const personalFixture = {
  id: 8,
  ownerUserId: 1,
  name: "阿宁聊创业",
  industry: "创业",
  audience: "早期创业者",
  description: "分享真实创业复盘。",
  profileType: "personal",
  contentPillars: ["创业复盘", "增长方法"],
  personaStyle: "真诚直接，第一人称复盘。",
  materialCount: 1,
  logo: null,
  assetTags: [],
  trendCount: 5,
  analysisCount: 1,
};

const secondPersonalFixture = {
  ...personalFixture,
  id: 9,
  name: "静姐说职场",
  industry: "职场",
  audience: "职场新人",
};

const brandFixture = {
  ...personalFixture,
  id: 7,
  name: "山茶护肤",
  profileType: "brand",
  contentPillars: [],
  personaStyle: "",
};

/** 断言从未请求过个人素材接口（本轮个人 IP 页不提供素材库）。 */
function expectNoMaterialRequests(fetchMock: ReturnType<typeof vi.fn>): void {
  const materialCalls = fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("/api/personal-materials"),
  );
  expect(materialCalls).toHaveLength(0);
}

describe("PersonalIpView", () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mountView(handlers: Record<string, FetchHandler>) {
    const fetchMock = stubFetch(handlers);
    const router = makeRouter();
    router.push("/personal");
    await router.isReady();
    const wrapper = mount(PersonalIpView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, router, fetchMock };
  }

  it("renders personal profiles with pillars and never auto-loads materials", async () => {
    // 故意不提供 GET /api/personal-materials handler：一旦组件自动加载素材，
    // stubFetch 会抛 unexpected fetch 使测试失败。
    const { wrapper, fetchMock } = await mountView({
      "GET /api/brands?summary=1": () =>
        jsonResponse(200, { brands: [brandFixture, personalFixture] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
    });

    const cards = wrapper.findAll("[data-testid=personal-card]");
    expect(cards).toHaveLength(1);
    const text = cards[0]!.text();
    expect(text).toContain("阿宁聊创业");
    expect(text).toContain("创业 · 早期创业者");
    expect(text).toContain("分享真实创业复盘。");
    expect(text).toContain("创业复盘");
    expect(text).toContain("表达风格：真诚直接，第一人称复盘。");
    expect(text).toContain("趋势 5 条");
    expect(wrapper.text()).not.toContain("山茶护肤");

    // 旧契约：个人 IP 页不渲染素材库。
    expectNoMaterialRequests(fetchMock);
    expect(wrapper.find("[data-testid=material-section]").exists()).toBe(false);
    expect(wrapper.find("[data-testid=material-card]").exists()).toBe(false);
  });

  it("shows the legacy empty-state copy without personal profiles", async () => {
    const { wrapper } = await mountView({
      "GET /api/brands?summary=1": () => jsonResponse(200, { brands: [brandFixture] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
    });

    expect(wrapper.text()).toContain(
      "你还没有个人 IP 档案。点击右上角“新增个人 IP”，就可以开始趋势分析和内容选题。",
    );
  });

  it("does not render the material management UI even with a selected profile", async () => {
    const { wrapper, fetchMock } = await mountView({
      "GET /api/brands?summary=1": () => jsonResponse(200, { brands: [personalFixture] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
    });

    // 第一个个人 IP 默认选中，但素材管理界面（表单/列表）必须不可达。
    expect(wrapper.find("[data-testid=personal-card]").classes()).toContain("is-selected");
    expect(wrapper.find("[data-testid=material-section]").exists()).toBe(false);
    expect(wrapper.find("form.material-form").exists()).toBe(false);
    expect(wrapper.find("select[name=kind]").exists()).toBe(false);
    expect(wrapper.find("textarea[name=content]").exists()).toBe(false);
    expectNoMaterialRequests(fetchMock);
  });

  it("switching the selected profile never fetches personal materials", async () => {
    const { wrapper, fetchMock } = await mountView({
      "GET /api/brands?summary=1": () =>
        jsonResponse(200, { brands: [personalFixture, secondPersonalFixture] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
    });

    const cards = wrapper.findAll("[data-testid=personal-card]");
    expect(cards).toHaveLength(2);
    await cards[1]!.trigger("click");
    await flushPromises();

    expect(cards[1]!.classes()).toContain("is-selected");
    expectNoMaterialRequests(fetchMock);
    expect(wrapper.find("[data-testid=material-section]").exists()).toBe(false);
  });
});
