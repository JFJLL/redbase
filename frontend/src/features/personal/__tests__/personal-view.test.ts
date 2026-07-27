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

const brandFixture = {
  ...personalFixture,
  id: 7,
  name: "山茶护肤",
  profileType: "brand",
  contentPillars: [],
  personaStyle: "",
};

const materialFixture = {
  id: 21,
  brandId: 8,
  kind: "experience",
  title: "第一次融资失败",
  content: "2023 年第一次融资被拒后复盘的三个教训。",
  tags: ["创业", "复盘"],
  sourceDate: "2023-06-01",
};

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

  it("renders personal profiles with pillars and loads their materials", async () => {
    const { wrapper } = await mountView({
      "GET /api/brands?summary=1": () =>
        jsonResponse(200, { brands: [brandFixture, personalFixture] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
      "GET /api/personal-materials?brandId=8": () =>
        jsonResponse(200, { items: [materialFixture] }),
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

    const material = wrapper.find("[data-testid=material-card]");
    expect(material.exists()).toBe(true);
    expect(material.text()).toContain("亲身经历");
    expect(material.text()).toContain("第一次融资失败");
    expect(material.text()).toContain("2023 年第一次融资被拒后复盘的三个教训。");
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

  it("creates a material with brandId, kind and comma-split tags", async () => {
    const { wrapper, fetchMock } = await mountView({
      "GET /api/brands?summary=1": () => jsonResponse(200, { brands: [personalFixture] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
      "GET /api/personal-materials?brandId=8": () => jsonResponse(200, { items: [] }),
      "POST /api/personal-materials": () => jsonResponse(201, { item: materialFixture }),
    });

    await wrapper.find("select[name=kind]").setValue("quote");
    await wrapper.find("input[name=title]").setValue("常说的一句话");
    await wrapper.find("textarea[name=content]").setValue("增长没有捷径，只有复利。");
    await wrapper.find("input[name=tags]").setValue("增长, 金句");
    await wrapper.find("form.material-form").trigger("submit");
    await flushPromises();

    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/personal-materials" && (init as RequestInit)?.method === "POST",
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      brandId: 8,
      kind: "quote",
      title: "常说的一句话",
      content: "增长没有捷径，只有复利。",
      tags: ["增长", "金句"],
      sourceDate: "",
    });
    expect(wrapper.text()).toContain("素材已添加");
  });

  it("surfaces the backend material error text verbatim", async () => {
    const { wrapper } = await mountView({
      "GET /api/brands?summary=1": () => jsonResponse(200, { brands: [personalFixture] }),
      "GET /api/history": () => jsonResponse(200, { generations: [] }),
      "GET /api/personal-materials?brandId=8": () => jsonResponse(200, { items: [] }),
      "POST /api/personal-materials": () => jsonResponse(400, { error: "请填写素材内容" }),
    });

    await wrapper.find("textarea[name=content]").setValue("   ");
    await wrapper.find("form.material-form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("素材保存失败：请填写素材内容");
  });
});
