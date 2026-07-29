import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import ExcellentView from "../views/ExcellentView.vue";

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

const LIST_ITEMS = [
  { noteId: "n1", title: "露营装备清单", imageUrls: ["/img/a.jpg"], metrics: { readCount: 10 } },
  { noteId: "n2", title: "晨间护肤流程", imageUrls: ["/img/b.jpg"], metrics: { readCount: 20 } },
];

type FetchCall = { url: string; init?: RequestInit };

function installFetchMock(handlers: (url: string, init?: RequestInit) => Response | undefined, calls: FetchCall[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const response = handlers(url, init);
      if (!response) throw new Error(`unhandled fetch: ${url}`);
      return response;
    }),
  );
}

function defaultHandlers(url: string): Response | undefined {
  if (url.startsWith("/api/excellent-contents/content-sources")) {
    return jsonResponse(200, { contentSources: [{ value: "buyer", label: "买手推荐" }] });
  }
  if (url.startsWith("/api/excellent-contents/taxonomy")) {
    return jsonResponse(200, { tree: { items: [{ label: "美妆", value: "小红书#美妆" }] } });
  }
  if (url.startsWith("/api/excellent-contents?")) {
    return jsonResponse(200, {
      board: "xhs_hot",
      contentSource: "all",
      categoryPath: "",
      items: LIST_ITEMS,
      updatedAt: "2026-07-01T08:00:00.000Z",
      hasCache: true,
    });
  }
  return undefined;
}

describe("ExcellentView", () => {
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountView(handlers: (url: string, init?: RequestInit) => Response | undefined = defaultHandlers) {
    installFetchMock(handlers, calls);
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(ExcellentView, {
      global: { plugins: [createPinia(), router] },
    });
    await flushPromises();
    return wrapper;
  }

  it("loads the cache-only list with board/contentSource params and renders cards", async () => {
    const wrapper = await mountView();

    const listCall = calls.find((call) => call.url.startsWith("/api/excellent-contents?"));
    expect(listCall).toBeTruthy();
    expect(listCall!.url).toContain("board=xhs_hot");
    expect(listCall!.url).toContain("contentSource=all");

    const cards = wrapper.findAll('[data-test="excellent-card"]');
    expect(cards).toHaveLength(2);
    expect(wrapper.text()).toContain("露营装备清单");
    expect(wrapper.text()).toContain("晨间护肤流程");
  });

  it("posts the draft filters snapshot on 更新内容 and commits them on success", async () => {
    const wrapper = await mountView((url, init) => {
      if (url === "/api/excellent-contents/refresh") {
        const body = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          board: body.board,
          contentSource: body.contentSource,
          categoryPath: body.categoryPath,
          industryPath: body.industryPath,
          items: LIST_ITEMS,
          updatedAt: "2026-07-02T09:00:00.000Z",
        });
      }
      return defaultHandlers(url);
    });

    await wrapper.find('[data-test="filter-source"]').setValue("buyer");
    await wrapper.find('[data-test="filter-category"]').setValue("小红书#美妆");
    // Dropdown changes only touch the draft filters — a pending hint is shown.
    expect(wrapper.find('[data-test="excellent-status"]').text()).toBe(
      "筛选条件将在点击“更新内容”后生效，当前仍展示上一次保存的数据。",
    );
    expect(calls.some((call) => call.url === "/api/excellent-contents/refresh")).toBe(false);

    await wrapper.find('[data-test="refresh-button"]').trigger("click");
    await flushPromises();

    const refreshCall = calls.find((call) => call.url === "/api/excellent-contents/refresh");
    expect(refreshCall).toBeTruthy();
    expect(refreshCall!.init?.method).toBe("POST");
    expect(JSON.parse(String(refreshCall!.init?.body))).toEqual({
      board: "xhs_hot",
      contentSource: "buyer",
      categoryPath: "小红书#美妆",
      industryPath: "",
    });
    // Draft filters committed: the dirty hint is gone.
    expect(wrapper.find('[data-test="excellent-status"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="toast"]').text()).toContain("已更新至");
  });

  it("keeps old items, rolls back drafts and shows the backend error verbatim on refresh failure", async () => {
    const wrapper = await mountView((url) => {
      if (url === "/api/excellent-contents/refresh") {
        return jsonResponse(502, { error: "优秀内容暂时无法更新，请稍后重试。" });
      }
      return defaultHandlers(url);
    });

    await wrapper.find('[data-test="filter-source"]').setValue("buyer");
    await wrapper.find('[data-test="refresh-button"]').trigger("click");
    await flushPromises();

    // Old items are preserved and the refresh error copy matches the legacy UI.
    expect(wrapper.findAll('[data-test="excellent-card"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="excellent-status"]').text()).toBe("更新失败，当前仍展示上一次保存的数据。");
    // Toast carries the backend error text verbatim.
    expect(wrapper.find('[data-test="toast"]').text()).toBe("优秀内容暂时无法更新，请稍后重试。");
    // Draft dropdown rolled back to the formal value.
    expect((wrapper.find('[data-test="filter-source"]').element as HTMLSelectElement).value).toBe("all");
  });

  it("shows the empty-state copy when the cache has no items", async () => {
    const wrapper = await mountView((url) => {
      if (url.startsWith("/api/excellent-contents?")) {
        return jsonResponse(200, { board: "xhs_hot", contentSource: "all", items: [], hasCache: false });
      }
      return defaultHandlers(url);
    });

    expect(wrapper.find('[data-test="excellent-empty"]').text()).toContain(
      "该筛选条件暂无已保存内容，请点击“更新内容”获取最新数据。",
    );
  });

  it("defers remix-analysis to the first 生成内容方向 click and degrades without blocking", async () => {
    const wrapper = await mountView((url, init) => {
      if (url.includes("/remix-analysis")) {
        return jsonResponse(503, { error: "参考方法分析暂时不可用" });
      }
      if (url.includes("/content-directions")) {
        return jsonResponse(200, { directions: [{ id: "d1", title: "方向一" }], analysisId: "", brandId: 7 });
      }
      if (url.includes("/excellent-remix-ideas")) {
        return jsonResponse(200, { brandId: 7, ideas: [] });
      }
      if (url.startsWith("/api/brands")) {
        return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      }
      void init;
      return defaultHandlers(url);
    });

    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();

    // 打开弹窗不再立即调参考分析（降低无意义模型消耗），展示惰性提示。
    expect(calls.some((call) => call.url.includes("/remix-analysis"))).toBe(false);
    expect(wrapper.find('[data-test="analysis-idle"]').exists()).toBe(true);

    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();

    const analysisCall = calls.find((call) => call.url.includes("/remix-analysis"));
    expect(analysisCall).toBeTruthy();
    expect(analysisCall!.url).toBe("/api/excellent-contents/n1/remix-analysis");
    expect(JSON.parse(String(analysisCall!.init?.body))).toEqual({
      board: "xhs_hot",
      contentSource: "all",
      categoryPath: "",
      industryPath: "",
    });
    // 分析失败降级但流程继续：错误原文展示，内容方向照常请求并渲染。
    expect(wrapper.find('[data-test="analysis-error"]').text()).toBe("参考方法分析暂时不可用");
    expect(calls.some((call) => call.url.includes("/content-directions"))).toBe(true);
    expect(wrapper.text()).toContain("方向一");
    expect(wrapper.find('[data-test="remix-brand"]').exists()).toBe(true);
  });

  function remixHandlers(analysis: Record<string, unknown>) {
    return (url: string, init?: RequestInit): Response | undefined => {
      if (url.includes("/remix-analysis")) {
        return jsonResponse(200, { analysis });
      }
      if (url.includes("/content-directions")) {
        return jsonResponse(200, { directions: [{ id: "d1", title: "方向一" }], analysisId: analysis.analysisId, brandId: 7 });
      }
      if (url.includes("/excellent-remix-ideas")) {
        return jsonResponse(200, { brandId: 7, ideas: [] });
      }
      if (url.startsWith("/api/brands")) {
        return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      }
      void init;
      return defaultHandlers(url);
    };
  }

  it("renders the collapsed AI learning summary with the multimodal status copy", async () => {
    const wrapper = await mountView(
      remixHandlers({
        analysisId: "an-1",
        analysisMode: "multimodal",
        referenceTopic: "露营装备清单",
        meta: { multimodalUsed: true },
        learningSummary: ["封面采用问题型标题", "前3页形成痛点-方法-总结结构", "视觉偏生活化信息卡表达"],
      }),
    );

    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();
    // 弹窗刚打开：尚未分析，无学习结果区域。
    expect(wrapper.find('[data-test="learning-summary"]').exists()).toBe(false);

    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();

    const details = wrapper.find('[data-test="learning-summary"]');
    expect(details.exists()).toBe(true);
    // 默认折叠（details 无 open 属性）。
    expect((details.element as HTMLDetailsElement).open).toBe(false);
    expect(wrapper.find('[data-test="learning-status"]').text()).toBe("AI已读取参考图片");
    const points = wrapper.findAll('[data-test="learning-point"]');
    expect(points.map((point) => point.text())).toEqual([
      "✓ 封面采用问题型标题",
      "✓ 前3页形成痛点-方法-总结结构",
      "✓ 视觉偏生活化信息卡表达",
    ]);
    expect(wrapper.find('[data-test="learning-warning"]').exists()).toBe(false);
  });

  it("shows the metadata_only status copy and the degrade warning verbatim", async () => {
    const wrapper = await mountView(
      remixHandlers({
        analysisId: "an-2",
        analysisMode: "metadata_only",
        referenceTopic: "露营装备清单",
        meta: { multimodalUsed: false },
        learningSummary: ["标题钩子：清单承诺结构"],
        warning: "未成功读取参考图片，本次基于标题和内容结构分析",
      }),
    );

    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="learning-status"]').text()).toBe("基于标题和结构分析");
    expect(wrapper.find('[data-test="learning-warning"]').text()).toBe(
      "未成功读取参考图片，本次基于标题和内容结构分析",
    );
    expect(wrapper.findAll('[data-test="learning-point"]')).toHaveLength(1);
  });

  async function mountViewWithAuth(
    handlers: (url: string, init?: RequestInit) => Response | undefined,
    user: Record<string, unknown> | null,
  ) {
    installFetchMock(handlers, calls);
    const pinia = createPinia();
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(ExcellentView, {
      global: { plugins: [pinia, router] },
    });
    const auth = useAuthStore(pinia);
    auth.user = user as never;
    await flushPromises();
    return { wrapper, auth };
  }

  function refreshSuccessHandlers(url: string, init?: RequestInit): Response | undefined {
    if (url === "/api/excellent-contents/refresh") {
      const body = JSON.parse(String(init?.body));
      return jsonResponse(200, {
        board: body.board,
        contentSource: body.contentSource,
        categoryPath: body.categoryPath,
        industryPath: body.industryPath,
        items: LIST_ITEMS,
        updatedAt: "2026-07-02T09:00:00.000Z",
      });
    }
    return defaultHandlers(url);
  }

  it("puts normal users into a 60s 更新中 countdown after refresh and blocks duplicate requests", async () => {
    const { wrapper } = await mountViewWithAuth(refreshSuccessHandlers, { id: "u1", credits: 5 });

    await wrapper.find('[data-test="refresh-button"]').trigger("click");
    await flushPromises();

    const button = wrapper.find('[data-test="refresh-button"]');
    expect(button.text()).toContain("更新中（");
    expect(button.attributes("disabled")).toBeDefined();

    // 冷却期内再点不产生第二次请求。
    const refreshCallsBefore = calls.filter((call) => call.url === "/api/excellent-contents/refresh").length;
    await button.trigger("click");
    await flushPromises();
    const refreshCallsAfter = calls.filter((call) => call.url === "/api/excellent-contents/refresh").length;
    expect(refreshCallsAfter).toBe(refreshCallsBefore);
  });

  it("starts the countdown from the server retryAfterSeconds on 429", async () => {
    const { wrapper } = await mountViewWithAuth((url) => {
      if (url === "/api/excellent-contents/refresh") {
        return jsonResponse(429, { error: "更新太频繁，请 42 秒后再试。", code: "REFRESH_COOLDOWN", retryAfterSeconds: 42 });
      }
      return defaultHandlers(url);
    }, { id: "u1", credits: 5 });

    await wrapper.find('[data-test="refresh-button"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="refresh-button"]').text()).toContain("更新中（42s）");
    expect(wrapper.find('[data-test="toast"]').text()).toContain("更新太频繁");
  });

  it("lets admins refresh repeatedly without a countdown", async () => {
    const { wrapper } = await mountViewWithAuth(refreshSuccessHandlers, { id: "a1", isAdmin: true, credits: 99 });

    await wrapper.find('[data-test="refresh-button"]').trigger("click");
    await flushPromises();

    const button = wrapper.find('[data-test="refresh-button"]');
    expect(button.text()).toBe("更新内容");
    expect(button.attributes("disabled")).toBeUndefined();

    await button.trigger("click");
    await flushPromises();
    expect(calls.filter((call) => call.url === "/api/excellent-contents/refresh").length).toBe(2);
  });

  it("shows the charge warning after the 3rd free direction success and the latest credits", async () => {
    const { wrapper, auth } = await mountViewWithAuth((url, init) => {
      if (url.includes("/remix-analysis")) {
        return jsonResponse(200, { analysis: { analysisId: "an-9", analysisMode: "metadata_only" } });
      }
      if (url.includes("/content-directions")) {
        return jsonResponse(200, {
          directions: [{ id: "d1", title: "方向一" }],
          analysisId: "an-9",
          brandId: 7,
          user: { id: "u1", credits: 7 },
          billing: {
            requestId: "req-3",
            cacheHit: false,
            replayed: false,
            charged: false,
            creditCost: 0,
            credits: 7,
            windowCount: 3,
            nextChargeable: true,
          },
        });
      }
      if (url.includes("/excellent-remix-ideas")) {
        return jsonResponse(200, { brandId: 7, ideas: [] });
      }
      if (url.startsWith("/api/brands")) {
        return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      }
      void init;
      return defaultHandlers(url);
    }, { id: "u1", credits: 8 });

    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();

    // 第 3 次免费成功后的轻提示 + 收费态按钮文案 + 最新余额。
    expect(wrapper.find('[data-test="toast"]').text()).toBe("短时间内继续生成将消耗 1 积分。");
    expect(wrapper.find('[data-test="generate-directions"]').text()).toBe("重新生成内容方向（1积分）");
    expect(wrapper.find('[data-test="remix-credits"]').text()).toContain("当前积分：7");
    expect(auth.user?.credits).toBe(7);
    // 融合按钮常驻标价。
    expect(wrapper.find('[data-test="generate-fusion"]').text()).toBe("生成融合方案（1积分）");
  });

  it("keeps cache-hit direction responses free of any charge toast", async () => {
    const { wrapper } = await mountViewWithAuth((url, init) => {
      if (url.includes("/remix-analysis")) {
        return jsonResponse(200, { analysis: { analysisId: "an-9", analysisMode: "metadata_only" } });
      }
      if (url.includes("/content-directions")) {
        return jsonResponse(200, {
          directions: [{ id: "d1", title: "方向一" }],
          analysisId: "an-9",
          brandId: 7,
          user: { id: "u1", credits: 8 },
          billing: {
            requestId: "req-cache",
            cacheHit: true,
            replayed: false,
            charged: false,
            creditCost: 0,
            credits: 8,
            windowCount: 3,
            nextChargeable: true,
          },
        });
      }
      if (url.includes("/excellent-remix-ideas")) {
        return jsonResponse(200, { brandId: 7, ideas: [] });
      }
      if (url.startsWith("/api/brands")) {
        return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      }
      void init;
      return defaultHandlers(url);
    }, { id: "u1", credits: 8 });

    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();

    // 缓存返回：不得出现任何扣费/将扣费提示。
    expect(wrapper.find('[data-test="toast"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("方向一");
  });

  it("reuses the direction requestId after a lost response, then rotates it after success", async () => {
    const directionBodies: Array<Record<string, unknown>> = [];
    const wrapper = await mountView((url, init) => {
      if (url.includes("/remix-analysis")) {
        return jsonResponse(200, { analysis: { analysisId: "an-retry", analysisMode: "metadata_only" } });
      }
      if (url.includes("/content-directions")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        directionBodies.push(body);
        if (directionBodies.length === 1) throw new TypeError("response lost");
        return jsonResponse(200, {
          directions: [{ id: "d1", title: "方向一" }],
          analysisId: "an-retry",
          brandId: 7,
          billing: { requestId: body.requestId, charged: false, replayed: directionBodies.length === 2 },
        });
      }
      if (url.includes("/excellent-remix-ideas")) return jsonResponse(200, { brandId: 7, ideas: [] });
      if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      return defaultHandlers(url);
    });

    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();

    expect(directionBodies).toHaveLength(2);
    expect(directionBodies[1].requestId).toBe(directionBodies[0].requestId);
    expect(directionBodies[0].forceRegenerate).toBe(false);
    expect(directionBodies[1].forceRegenerate).toBe(false);

    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();
    expect(directionBodies[2].requestId).not.toBe(directionBodies[1].requestId);
    expect(directionBodies[2].forceRegenerate).toBe(true);
  });

  it("keeps a direction attempt through REQUEST_IN_PROGRESS but rotates it when inputs change", async () => {
    const directionBodies: Array<Record<string, unknown>> = [];
    const wrapper = await mountView((url, init) => {
      if (url.includes("/remix-analysis")) {
        return jsonResponse(200, { analysis: { analysisId: "an-pending", analysisMode: "metadata_only" } });
      }
      if (url.includes("/content-directions")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        directionBodies.push(body);
        if (directionBodies.length <= 2) {
          return jsonResponse(409, { error: "请求仍在处理中", code: "REQUEST_IN_PROGRESS" });
        }
        return jsonResponse(200, {
          directions: [{ id: "d1", title: "方向一" }],
          analysisId: "an-pending",
          brandId: 7,
          billing: { requestId: body.requestId, charged: false },
        });
      }
      if (url.includes("/excellent-remix-ideas")) return jsonResponse(200, { brandId: 7, ideas: [] });
      if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      return defaultHandlers(url);
    });

    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();
    expect(directionBodies[1].requestId).toBe(directionBodies[0].requestId);

    await wrapper.findAll(".remix-focus-item input")[0].setValue(false);
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();
    expect(directionBodies[2].requestId).not.toBe(directionBodies[1].requestId);
  });

  it("preserves fusion forceRegenerate and requestId across a lost regeneration response", async () => {
    const fusionBodies: Array<Record<string, unknown>> = [];
    const fusionPlan = {
      contentGenerationMode: "ai",
      carouselPack: { slides: [1, 2, 3, 4].map((index) => ({ title: `第${index}页` })) },
    };
    const wrapper = await mountView((url, init) => {
      if (url.includes("/remix-analysis")) {
        return jsonResponse(200, { analysis: { analysisId: "an-fusion", analysisMode: "metadata_only" } });
      }
      if (url.includes("/content-directions")) {
        return jsonResponse(200, {
          directions: [{ id: "d1", title: "方向一", summary: "摘要" }],
          analysisId: "an-fusion",
          brandId: 7,
        });
      }
      if (url.includes("/fusion-plan")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        fusionBodies.push(body);
        if (fusionBodies.length === 2) throw new TypeError("response lost after server success");
        return jsonResponse(200, {
          fusionPlan,
          billing: { requestId: body.requestId, charged: true, replayed: fusionBodies.length === 3 },
        });
      }
      if (url.includes("/excellent-remix-ideas")) return jsonResponse(200, { brandId: 7, ideas: [] });
      if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      return defaultHandlers(url);
    });

    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-fusion"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-fusion"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-fusion"]').trigger("click");
    await flushPromises();

    expect(fusionBodies[0].forceRegenerate).toBe(false);
    expect(fusionBodies[1].forceRegenerate).toBe(true);
    expect(fusionBodies[2].forceRegenerate).toBe(true);
    expect(fusionBodies[2].requestId).toBe(fusionBodies[1].requestId);

    await wrapper.find('[data-test="generate-fusion"]').trigger("click");
    await flushPromises();
    expect(fusionBodies[3].requestId).not.toBe(fusionBodies[2].requestId);
    expect(fusionBodies[3].forceRegenerate).toBe(true);
  });

  it("uses a new fusion requestId when the selected direction changes after failure", async () => {
    const fusionBodies: Array<Record<string, unknown>> = [];
    const wrapper = await mountView((url, init) => {
      if (url.includes("/remix-analysis")) {
        return jsonResponse(200, { analysis: { analysisId: "an-fusion-input", analysisMode: "metadata_only" } });
      }
      if (url.includes("/content-directions")) {
        return jsonResponse(200, {
          directions: [
            { id: "d1", title: "方向一", summary: "摘要一" },
            { id: "d2", title: "方向二", summary: "摘要二" },
          ],
          analysisId: "an-fusion-input",
          brandId: 7,
        });
      }
      if (url.includes("/fusion-plan")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        fusionBodies.push(body);
        if (fusionBodies.length === 1) throw new TypeError("response lost");
        return jsonResponse(200, {
          fusionPlan: { carouselPack: { slides: [1, 2, 3, 4].map((index) => ({ title: `第${index}页` })) } },
          billing: { requestId: body.requestId, charged: true },
        });
      }
      if (url.includes("/excellent-remix-ideas")) return jsonResponse(200, { brandId: 7, ideas: [] });
      if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      return defaultHandlers(url);
    });

    await wrapper.find('[data-test="remix-button"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-directions"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="generate-fusion"]').trigger("click");
    await flushPromises();
    await wrapper.findAll(".remix-direction input")[1].setValue(true);
    await wrapper.find('[data-test="generate-fusion"]').trigger("click");
    await flushPromises();

    expect(fusionBodies[1].requestId).not.toBe(fusionBodies[0].requestId);
  });
});
