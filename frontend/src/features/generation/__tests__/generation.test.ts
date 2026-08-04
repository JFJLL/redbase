import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import GenerationView from "../views/GenerationView.vue";
import { pollImageJob, IMAGE_JOB_POLL_INTERVAL_MS } from "../api";

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
      { path: "/ideas", name: "ideas", component: { template: "<div />" } },
      { path: "/generation", name: "generation", component: { template: "<div />" } },
    ],
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

describe("GenerationView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountView() {
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    return mount(GenerationView, { global: { plugins: [createPinia(), router] } });
  }

  it("shows a productized task overview without the bare edit form", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountView();

    expect(wrapper.find('[data-test="no-context-overview"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="no-context-hint"]').text()).toContain("朋友圈图");
    expect(wrapper.find('[data-test="no-context-hint"]').text()).toContain("公众号长图");
    expect(wrapper.find('[data-test="no-context-hint"]').text()).toContain("小红书组图");
    expect(wrapper.find('[data-test="no-context-hint"]').text()).toContain("风格化图");
    expect(wrapper.find('[data-test="no-context-go-ideas"]').exists()).toBe(true);
    // 图3 的裸表单必须消失：原图地址 / 改图提示词 / 提交改图任务。
    expect(wrapper.find('input[name="imageUrl"]').exists()).toBe(false);
    expect(wrapper.find('textarea[name="prompt"]').exists()).toBe(false);
    expect(wrapper.find("form.generation-form").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("提交改图任务");
  });

  it("guides from the empty state to the ideas page to pick a topic", async () => {
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();

    await wrapper.find('[data-test="no-context-go-ideas"]').trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("ideas");
  });

  it("does not auto-start any generation when entering from the sidebar without an action", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET" && url === "/api/brands/1") {
        return jsonResponse(200, {
          brand: {
            id: 1,
            name: "测试品牌",
            profileType: "brand",
            logo: null,
            trends: [
              {
                key: "b1",
                title: "热点趋势",
                description: "",
                items: [{ id: 5, title: "夏日趋势", ideas: [{ title: "选题一", summary: "摘要" }] }],
              },
            ],
          },
        });
      }
      if (method === "GET" && url.split("?")[0] === "/api/product-images") {
        return jsonResponse(200, { images: [] });
      }
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = makeRouter();
    await router.push({ name: "generation", query: { brandId: "1", trendId: "5", ideaIndex: "0" } });
    await router.isReady();
    const wrapper = mount(GenerationView, { global: { plugins: [createPinia(), router] } });
    await flushPromises();
    await flushPromises();

    const imagePosts = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).includes("/ideas/0/image") && String((init as RequestInit | undefined)?.method || "GET") === "POST",
    );
    expect(imagePosts).toHaveLength(0);
    expect(wrapper.find('[data-test="context-loading"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="idea-context"]').exists()).toBe(true);
  });
});
