import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "@/features/ideas/views/IdeasView.vue";
import { makeBrandDetail, makeTrend } from "@/features/trends/__tests__/insightsTestUtils";
import { pollImageJob, IMAGE_JOB_POLL_INTERVAL_MS } from "../api";
import { makeIdeasRouter, installFlowFetch } from "../__tests__/ideasGenerationHarness";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("pollImageJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("polls every 5s until the job completes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { status: "pending" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "pending" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "completed",
          imageConcept: { imageUrl: "/api/generated-images/9/file?sig=x" },
          generationId: 9,
          persisted: true,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const promise = pollImageJob("abc123");
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/image-jobs/abc123");
    expect(result.imageUrl).toBe("/api/generated-images/9/file?sig=x");
    expect(result.generationId).toBe(9);
    expect(result.persisted).toBe(true);
  });

  it("throws the backend error verbatim when the job fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { status: "failed", error: "图片生成服务繁忙，请稍后再试" })),
    );

    await expect(pollImageJob("abc123")).rejects.toThrow("图片生成服务繁忙，请稍后再试");
  });

  it("stops polling when the signal aborts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: "pending" }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const promise = pollImageJob("abc123", { signal: controller.signal });
    const rejection = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    controller.abort();
    await rejection;

    // No further polls after abort, no matter how much time passes.
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("real ideas entry (GenerationView removed)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("the ideas page hosts all four generation actions with no bare edit form anywhere", async () => {
    const brandDetail = {
      brand: makeBrandDetail([makeTrend(5, { id: 5, title: "夏日趋势" })], { id: 1, name: "测试品牌" }),
    };
    const fetchMock = installFlowFetch({ brandId: 1, brandDetail });
    vi.stubGlobal("fetch", fetchMock);
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
    auth.sessionLoaded = true;
    const router = makeIdeasRouter();
    await router.push({ name: "ideas" });
    await router.isReady();
    const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();

    // 四个生图动作仍存在（生产入口是内容选题页）。
    expect(wrapper.find('[data-test="idea-generate-moments-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="idea-generate-wechat-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="idea-generate-xhs-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="idea-generate-script-0"]').exists()).toBe(true);
    // 图3 的裸表单必须消失：原图地址 / 改图提示词 / 提交改图任务。
    expect(wrapper.find('input[name="imageUrl"]').exists()).toBe(false);
    expect(wrapper.find('textarea[name="prompt"]').exists()).toBe(false);
    expect(wrapper.find("form.generation-form").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("提交改图任务");
    // 无 action 时不打开生成对话框。
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(false);
  });

  it("/generation still guides to the ideas page preserving the deep-link query", async () => {
    const router = makeIdeasRouter();
    await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "0", action: "moments" } });
    await router.isReady();
    expect(router.currentRoute.value.name).toBe("ideas");
    expect(router.currentRoute.value.query).toEqual({
      brandId: "1",
      trendId: "5",
      ideaIndex: "0",
      action: "moments",
    });
  });

  it("entering the ideas page without an action never auto-starts a generation", async () => {
    const brandDetail = {
      brand: makeBrandDetail([makeTrend(5, { id: 5, title: "夏日趋势" })], { id: 1, name: "测试品牌" }),
    };
    const fetchMock = installFlowFetch({ brandId: 1, brandDetail, productImages: { images: [] } });
    vi.stubGlobal("fetch", fetchMock);
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
    auth.sessionLoaded = true;
    const router = makeIdeasRouter();
    await router.push({ name: "ideas", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
    await router.isReady();
    const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();

    const imagePosts = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).includes("/ideas/0/image") && String((init as RequestInit | undefined)?.method || "GET") === "POST",
    );
    expect(imagePosts).toHaveLength(0);
    expect(wrapper.find('[data-test="idea-context"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(false);
  });
});
