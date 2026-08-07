import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import HistoryView from "../views/HistoryView.vue";
import {
  hasExpiredAssetSignature,
  matchesGenerationHistoryFilters,
  normalizeHistoryDateBoundary,
  parseAssetExpiryMs,
} from "../api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: { template: "<div />" } },
      { path: "/login", name: "login", component: { template: "<div />" } },
    ],
  });
}

const GENERATIONS = [
  {
    id: 1,
    type: "moments",
    cardTitle: "露营朋友圈图",
    brandName: "品牌A",
    brandId: 7,
    trendTitle: "五一露营潮",
    ideaTitle: "露营装备清单",
    channelLabel: "朋友圈",
    createdAt: "2026-07-20T08:00:00.000Z",
    previewUrl: "/api/generated-images/1/file?sig=aaa",
    payload: { caption: "露营去咯", visualDirection: "清新自然", aspectRatio: "3:4" },
  },
  {
    id: 2,
    type: "xhsCarousel",
    cardTitle: "护肤小红书组图",
    brandName: "品牌B",
    brandId: 8,
    trendTitle: "夏日护肤",
    ideaTitle: "晨间流程",
    channelLabel: "小红书",
    createdAt: "2026-07-21T08:00:00.000Z",
    payload: {
      publishTitle: "晨间护肤这样做",
      publishCaption: "收藏这套流程",
      slides: [{ title: "第1页", imageUrl: "/api/generated-images/2/slides/0/file?sig=bbb" }],
    },
  },
];

type FetchCall = { url: string; init?: RequestInit };

describe("HistoryView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountView(overrides?: (url: string, init?: RequestInit) => Response | undefined) {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const custom = overrides?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
        if (url.startsWith("/api/history")) return jsonResponse(200, { generations: GENERATIONS });
        throw new Error(`unhandled fetch: ${url}`);
      }),
    );
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(HistoryView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    return { wrapper, calls };
  }

  it("renders history cards with type labels and signed image URLs untouched", async () => {
    const { wrapper, calls } = await mountView();

    expect(calls.some((call) => call.url === "/api/history")).toBe(true);
    const cards = wrapper.findAll('[data-test="history-card"]');
    expect(cards).toHaveLength(2);
    expect(wrapper.text()).toContain("朋友圈图文");
    expect(wrapper.text()).toContain("小红书组图");
    expect(wrapper.text()).toContain("查看所有生成过的图片、标题和文案，统一回看并复用已产出的内容资产。");
    expect(wrapper.text()).toContain("历史生成图片会保存七天，请及时下载。");
    expect(wrapper.text()).not.toContain("30 天内的生成记录");
    // Signed URLs from the backend are used verbatim.
    expect(wrapper.find('img[src="/api/generated-images/1/file?sig=aaa"]').exists()).toBe(true);
    expect(wrapper.find('img[src="/api/generated-images/2/slides/0/file?sig=bbb"]').exists()).toBe(true);
  });

  it("sends DELETE /api/history/:id after confirm and removes the card", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { wrapper, calls } = await mountView((url, init) => {
      if (url === "/api/history/1" && init?.method === "DELETE") {
        return jsonResponse(200, { ok: true, deletedGenerationId: 1 });
      }
      return undefined;
    });

    await wrapper.findAll('[data-test="history-delete"]')[0].trigger("click");
    await flushPromises();

    expect(confirm).toHaveBeenCalledWith("确定删除「露营朋友圈图」吗？删除后将无法找回。");
    const deleteCall = calls.find((call) => call.url === "/api/history/1");
    expect(deleteCall?.init?.method).toBe("DELETE");
    expect(wrapper.findAll('[data-test="history-card"]')).toHaveLength(1);
  });

  it("keeps the card and alerts with the backend error verbatim when deletion fails", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const { wrapper } = await mountView((url, init) => {
      if (url === "/api/history/1" && init?.method === "DELETE") {
        return jsonResponse(500, { error: "数据库繁忙，请稍后再试" });
      }
      return undefined;
    });

    await wrapper.findAll('[data-test="history-delete"]')[0].trigger("click");
    await flushPromises();

    expect(alertMock).toHaveBeenCalledWith("删除失败：数据库繁忙，请稍后再试");
    expect(wrapper.findAll('[data-test="history-card"]')).toHaveLength(2);
  });

  it("passes filters as query params when reloading", async () => {
    vi.useFakeTimers();
    try {
      const { wrapper, calls } = await mountView();
      await wrapper.find('[data-test="history-type"]').setValue("moments");
      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();
      expect(calls.some((call) => call.url === "/api/history?type=moments")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters items locally exactly like the legacy matcher", () => {
    const item = GENERATIONS[0];
    expect(matchesGenerationHistoryFilters(item, { q: "露营", brandId: "", type: "", from: "", to: "" })).toBe(true);
    expect(matchesGenerationHistoryFilters(item, { q: "护肤", brandId: "", type: "", from: "", to: "" })).toBe(false);
    expect(matchesGenerationHistoryFilters(item, { q: "", brandId: "7", type: "moments", from: "", to: "" })).toBe(true);
    expect(
      matchesGenerationHistoryFilters(item, { q: "", brandId: "", type: "", from: "2026-07-21", to: "" }),
    ).toBe(false);
    expect(normalizeHistoryDateBoundary("2026-07-21", "to")).toBe("2026-07-21T23:59:59.999Z");
    expect(normalizeHistoryDateBoundary("2026-07-21", "from")).toBe("2026-07-21T00:00:00.000Z");
  });

  it("parses signed URL expiry and detects expired asset signatures", () => {
    expect(parseAssetExpiryMs("/api/generated-images/1/file?assetExpires=1000&assetSignature=s")).toBe(1000);
    expect(parseAssetExpiryMs("/api/generated-images/1/file?sig=aaa")).toBe(0);
    expect(hasExpiredAssetSignature("/api/generated-images/1/file?assetExpires=1000&assetSignature=s", 2000)).toBe(true);
    expect(hasExpiredAssetSignature("/api/generated-images/1/file?assetExpires=9999999999999&assetSignature=s", 2000)).toBe(false);
    expect(hasExpiredAssetSignature("/api/generated-images/1/file?sig=aaa", 2000)).toBe(false);
  });

  it("refreshes history exactly once when an expired signed image fails, then replaces the src", async () => {
    vi.useFakeTimers();
    try {
      const EXPIRED_URL = "/api/generated-images/1/file?assetExpires=1000&assetSignature=expired-sig";
      const FRESH_URL = "/api/generated-images/1/file?assetExpires=9999999999999&assetSignature=fresh-sig";
      let historyCalls = 0;
      const { wrapper } = await mountView((url) => {
        if (url.startsWith("/api/history")) {
          historyCalls += 1;
          const previewUrl = historyCalls === 1 ? EXPIRED_URL : FRESH_URL;
          return jsonResponse(200, { generations: [{ ...GENERATIONS[0], previewUrl }] });
        }
        return undefined;
      });

      expect(historyCalls).toBe(1);
      const expiredImg = wrapper.find(`img[src="${EXPIRED_URL}"]`);
      expect(expiredImg.exists()).toBe(true);

      await expiredImg.trigger("error");
      await vi.advanceTimersByTimeAsync(300);
      await flushPromises();

      expect(historyCalls).toBe(2);
      expect(wrapper.find(`img[src="${FRESH_URL}"]`).exists()).toBe(true);

      // A fresh signed URL that still fails is a real error: no second refresh.
      await wrapper.find(`img[src="${FRESH_URL}"]`).trigger("error");
      await vi.advanceTimersByTimeAsync(300);
      await flushPromises();
      expect(historyCalls).toBe(2);
      expect(wrapper.find('[data-test="history-image-error"]').exists()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an explicit error state with retry when a non-expired image fails", async () => {
    const { wrapper } = await mountView();
    const img = wrapper.find('img[src="/api/generated-images/1/file?sig=aaa"]');
    expect(img.exists()).toBe(true);

    await img.trigger("error");
    expect(wrapper.find('[data-test="history-image-error"]').exists()).toBe(true);

    await wrapper.find('[data-test="history-image-retry"]').trigger("click");
    expect(wrapper.find('img[src="/api/generated-images/1/file?sig=aaa"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="history-image-error"]').exists()).toBe(false);
  });
});

describe("HistoryView detail workbench (restored legacy contract)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const DETAIL_GENERATIONS = [
    {
      id: 1,
      type: "moments",
      cardTitle: "露营朋友圈图",
      brandName: "品牌A",
      brandId: 7,
      channelLabel: "朋友圈",
      ideaTitle: "露营装备清单",
      createdAt: "2026-07-20T08:00:00.000Z",
      previewUrl: "/api/generated-images/1/file?sig=aaa",
      payload: { caption: "露营去咯", visualDirection: "清新自然", aspectRatio: "3:4", editHistory: [] },
    },
    {
      id: 2,
      type: "xhsCarousel",
      cardTitle: "护肤小红书组图",
      brandName: "品牌B",
      brandId: 8,
      channelLabel: "小红书",
      ideaTitle: "晨间流程",
      createdAt: "2026-07-21T08:00:00.000Z",
      previewUrl: "/api/generated-images/2/0/file?sig=bbb",
      payload: {
        publishTitle: "晨间护肤这样做",
        publishCaption: "收藏这套流程",
        aspectRatio: "3:4",
        slides: [
          {},
          { title: "第2页", imageUrl: "/api/generated-images/2/1/file?sig=ccc" },
          {},
          { title: "第4页", imageUrl: "/api/generated-images/2/3/file?sig=eee" },
        ],
        editHistory: [
          {
            id: "edit-1",
            imageUrl: "/api/generated-images/2/edit-1/file?sig=ddd",
            title: "改图一",
            createdAt: "2026-07-21T09:00:00.000Z",
            sourceSlideIndex: 3,
          },
          {
            id: "edit-2",
            imageUrl: "/api/generated-images/2/edit-2/file?sig=fff",
            title: "改图二",
            createdAt: "2026-07-21T10:00:00.000Z",
          },
        ],
      },
    },
  ];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountDetail() {
    const counts = { historyCalls: 0, sessionCalls: 0 };
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET");
      if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      if (url.startsWith("/api/history")) {
        counts.historyCalls += 1;
        return jsonResponse(200, { generations: DETAIL_GENERATIONS });
      }
      if (url === "/api/session") {
        counts.sessionCalls += 1;
        return jsonResponse(200, { user: { id: "1", credits: 8 } });
      }
      if (method === "POST" && url === "/api/image-edits") {
        return jsonResponse(202, { jobId: "job-1", user: { id: "1", credits: 7 } });
      }
      if (method === "GET" && url === "/api/image-jobs/job-1") {
        return jsonResponse(200, {
          status: "completed",
          imageConcept: { imageUrl: "/api/generated-images/99/edit/file?sig=new", title: "改图新结果" },
          generationId: 99,
          persisted: true,
        });
      }
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(HistoryView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    return { wrapper, counts };
  }

  it("keeps the original-image edit form permanently visible with asset info and a two-column layout", async () => {
    const { wrapper } = await mountDetail();
    await wrapper.findAll('[data-test="history-detail"]')[0].trigger("click");
    await flushPromises();

    // 表单常驻：打开详情即可见，无「改图/收起改图」开关按钮
    expect(wrapper.find('[data-test="image-edit-panel"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain("收起改图");
    expect(wrapper.find('button[data-test="history-edit-open"]').exists()).toBe(false);

    // 顶部资产信息：来源选题 + 发布文案
    const header = wrapper.find('[data-test="history-asset-header"]');
    expect(header.exists()).toBe(true);
    expect(header.text()).toContain("露营装备清单");
    expect(header.text()).toContain("朋友圈文案：");
    expect(header.text()).toContain("露营去咯");
    expect(header.text()).toContain("视觉方向：");
    expect(header.text()).toContain("清新自然");

    // 左图右表单双栏
    const grid = wrapper.find('[data-test="history-detail-grid"]');
    expect(grid.exists()).toBe(true);
    const preview = wrapper.find('[data-test="history-detail-preview"] img');
    expect(preview.attributes("src")).toBe("/api/generated-images/1/file?sig=aaa");
    const form = wrapper.find('[data-test="history-edit-open"]');
    expect(form.find('[data-test="image-edit-panel"]').exists()).toBe(true);
    expect(Array.from(grid.element.children)).toHaveLength(2);
  });

  it("renders only real carousel pages as tabs and edits with the original sourceIndex", async () => {
    const { wrapper } = await mountDetail();
    await wrapper.findAll('[data-test="history-detail"]')[1].trigger("click");
    await flushPromises();

    // 只渲染真实存在页的 tab，保留原始 sourceIndex
    expect(wrapper.find('[data-test="history-slide-tab-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="history-slide-tab-3"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="history-slide-tab-0"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="history-slide-tab-2"]').exists()).toBe(false);

    // 选择第 4 页（原始索引 3）后左侧预览与右侧表单同步，表单常驻
    await wrapper.find('[data-test="history-slide-tab-3"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="history-detail-preview"] img').attributes("src")).toBe(
      "/api/generated-images/2/3/file?sig=eee",
    );
    expect(wrapper.find('[data-test="image-edit-panel"]').exists()).toBe(true);

    await wrapper.find('[data-test="image-edit-prompt"]').setValue("改第四页构图");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.generationId).toBe(2);
    expect(body.slideIndex).toBe(3);
    expect(body.imageUrl).toBe("/api/generated-images/2/3/file?sig=eee");
  });

  it("shows an inline edit panel per history record that submits generationId/parentEditId/slideIndex", async () => {
    const { wrapper, counts } = await mountDetail();
    await wrapper.findAll('[data-test="history-detail"]')[1].trigger("click");
    await flushPromises();

    const record = wrapper.find('[data-test="history-edit-history-item-edit-1"]');
    expect(record.exists()).toBe(true);
    expect(record.text()).toContain("改图一");
    expect(record.find('[data-test="history-edit-history-time"]').text()).not.toBe("");

    // 记录内联面板：点击记录后其内部出现 ImageEditPanel，主表单让位
    await record.trigger("click");
    await flushPromises();
    expect(record.find('[data-test="image-edit-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="history-edit-open"] [data-test="image-edit-panel"]').exists()).toBe(false);

    await record.find('[data-test="image-edit-prompt"]').setValue("再改一版");
    await record.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      generationId: 2,
      parentEditId: "edit-1",
      slideIndex: 3,
      imageUrl: "/api/generated-images/2/edit-1/file?sig=ddd",
    });

    // 成功（@edited）后刷新积分与历史列表
    expect(counts.sessionCalls).toBeGreaterThanOrEqual(1);
    expect(counts.historyCalls).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the selected detail slide index when a history record has no sourceSlideIndex", async () => {
    const { wrapper } = await mountDetail();
    await wrapper.findAll('[data-test="history-detail"]')[1].trigger("click");
    await flushPromises();

    await wrapper.find('[data-test="history-slide-tab-1"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="history-edit-history-item-edit-2"]').trigger("click");
    await flushPromises();
    const record = wrapper.find('[data-test="history-edit-history-item-edit-2"]');
    await record.find('[data-test="image-edit-prompt"]').setValue("基于第二页继续改");
    await record.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.parentEditId).toBe("edit-2");
    expect(body.slideIndex).toBe(1);
  });
});
