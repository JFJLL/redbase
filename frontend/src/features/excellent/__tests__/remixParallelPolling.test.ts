/**
 * 任务2：优秀内容仿图文的多页并行轮询行为测试（组件级，mock 全局 fetch）。
 * 旧版 excellent-remix-request.js 并发队列语义：slide 提交按页序保序，但
 * 图片任务轮询并发进行——不得等上一页出图才提交/轮询下一页。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { IMAGE_JOB_POLL_INTERVAL_MS } from "@/features/generation/api";
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

const LIST_ITEMS = [{ noteId: "n1", title: "露营装备清单", imageUrls: ["/img/a.jpg"], metrics: { readCount: 10 } }];

const FUSION_PLAN = {
  fusionPlan: {
    contentThesis: "论点",
    carouselPack: {
      title: "融合组图",
      publishTitle: "发布标题",
      slides: [{ title: "S1" }, { title: "S2" }, { title: "S3" }, { title: "S4" }],
    },
  },
};

function makeRemixFetch(jobHandler: (jobId: string) => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (url.startsWith("/api/excellent-contents/content-sources")) {
      return jsonResponse(200, { contentSources: [{ value: "buyer", label: "买手推荐" }] });
    }
    if (url.startsWith("/api/excellent-contents/taxonomy")) {
      return jsonResponse(200, { tree: { items: [{ label: "美妆", value: "小红书#美妆" }] } });
    }
    if (url.startsWith("/api/excellent-contents?")) {
      return jsonResponse(200, { board: "xhs_hot", contentSource: "all", items: LIST_ITEMS, hasCache: true });
    }
    if (url === "/api/excellent-contents/n1/remix-analysis") {
      return jsonResponse(200, { analysis: { analysisId: "a1" } });
    }
    if (url === "/api/brands" && method === "GET") {
      return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
    }
    if (url === "/api/brands/7/excellent-remix-ideas") {
      return jsonResponse(200, { brandId: 7, ideas: [] });
    }
    if (url === "/api/excellent-contents/n1/fusion-plan") {
      return jsonResponse(200, FUSION_PLAN);
    }
    if (url === "/api/brands/7/excellent-remix-preview") {
      return jsonResponse(200, {
        carouselGroupId: "grp-1",
        carouselPack: { title: "融合组图", slides: FUSION_PLAN.fusionPlan.carouselPack.slides },
        user: { id: "u1" },
      });
    }
    const slideMatch = url.match(/^\/api\/brands\/7\/excellent-remix\/slides\/(\d+)$/);
    if (slideMatch && method === "POST") {
      return jsonResponse(202, { slideJob: { slideIndex: Number(slideMatch[1]), jobId: `rjob-${slideMatch[1]}` }, user: { id: "u1" } });
    }
    const jobMatch = url.match(/^\/api\/image-jobs\/(rjob-\d+)/);
    if (jobMatch) return jobHandler(jobMatch[1]);
    if (url === "/api/brands/7/excellent-remix/complete" && method === "POST") {
      return jsonResponse(200, { generation: { id: 1 }, user: { id: "u1" } });
    }
    throw new Error(`unhandled fetch: ${method} ${url}`);
  });
}

async function mountAndReachSubmit(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const router = makeRouter();
  await router.push("/");
  await router.isReady();
  const wrapper = mount(ExcellentView, { global: { plugins: [createPinia(), router] } });
  await flushPromises();

  await wrapper.find('[data-test="remix-button"]').trigger("click");
  await flushPromises();

  // 自定义内容方向（≥5 字）→ 生成融合方案 → 可提交。
  await wrapper.find('input[type="radio"][value="custom"]').setValue();
  await wrapper.find('[data-test="custom-direction"]').setValue("学习它的封面排版与信息结构");
  await wrapper.find('[data-test="generate-fusion"]').trigger("click");
  await flushPromises();
  expect(wrapper.find('[data-test="fusion-slides"]').exists()).toBe(true);
  return wrapper;
}

function callsMatching(fetchMock: ReturnType<typeof vi.fn>, pattern: RegExp): string[] {
  return fetchMock.mock.calls.map((entry) => String(entry[0])).filter((url) => pattern.test(url));
}

describe("ExcellentView remix parallel slide polling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("submits all four slides in order without waiting for polls and polls them concurrently", async () => {
    vi.useFakeTimers();
    try {
      // 图片任务始终 pending：串行实现会卡在第 1 页的轮询上。
      const fetchMock = makeRemixFetch(() => jsonResponse(200, { status: "pending" }));
      const wrapper = await mountAndReachSubmit(fetchMock);

      await wrapper.find('[data-test="remix-submit"]').trigger("click");
      await flushPromises();

      // 4 页全部已提交（页序保序），尽管没有任何 job 出图。
      const slidePosts = callsMatching(fetchMock, /\/excellent-remix\/slides\/\d+$/);
      expect(slidePosts).toEqual([
        "/api/brands/7/excellent-remix/slides/0",
        "/api/brands/7/excellent-remix/slides/1",
        "/api/brands/7/excellent-remix/slides/2",
        "/api/brands/7/excellent-remix/slides/3",
      ]);

      // 推进 5s：并行轮询应覆盖 ≥2 个不同 job（实际 4 个）。
      await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
      await flushPromises();
      const distinctJobs = new Set(
        callsMatching(fetchMock, /\/api\/image-jobs\//).map((url) => url.split("/").pop()),
      );
      expect(distinctJobs.size).toBeGreaterThanOrEqual(2);
      expect(distinctJobs).toEqual(new Set(["rjob-0", "rjob-1", "rjob-2", "rjob-3"]));

      // 没有页面完成前不得写入历史。
      expect(callsMatching(fetchMock, /excellent-remix\/complete$/)).toHaveLength(0);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes exactly once with all four slide job ids after every poll resolves", async () => {
    const fetchMock = makeRemixFetch(() =>
      jsonResponse(200, {
        status: "completed",
        imageConcept: { imageUrl: "/api/generated-images/9/file?sig=r" },
      }),
    );
    const wrapper = await mountAndReachSubmit(fetchMock);

    await wrapper.find('[data-test="remix-submit"]').trigger("click");
    await flushPromises();

    const completeCalls = fetchMock.mock.calls.filter(
      (entry) => String(entry[0]) === "/api/brands/7/excellent-remix/complete",
    );
    expect(completeCalls).toHaveLength(1);
    const completeBody = JSON.parse(String((completeCalls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(completeBody).toEqual({
      carouselGroupId: "grp-1",
      slideJobIds: ["rjob-0", "rjob-1", "rjob-2", "rjob-3"],
      expectedSlideCount: 4,
    });
    expect(wrapper.find('[data-test="submit-done"]').exists()).toBe(true);
  });
});
