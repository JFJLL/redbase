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

  it("requires a prompt before submitting, matching the legacy copy", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountView();

    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="job-error"]').text()).toBe("请先填写改图提示词。");
  });

  it("submits the edit request body and stops polling after unmount", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url === "/api/image-edits") {
        return jsonResponse(202, { jobId: "job1" });
      }
      if (url.startsWith("/api/image-jobs/")) {
        return jsonResponse(200, { status: "pending" });
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountView();

    await wrapper.find('input[name="imageUrl"]').setValue("/api/generated-images/3/file?sig=abc");
    await wrapper.find('textarea[name="prompt"]').setValue("把背景换成米白色");
    await wrapper.find('input[name="title"]').setValue("产品图");
    await wrapper.find('form').trigger("submit");
    await flushPromises();

    const editCall = fetchMock.mock.calls.find((call) => String(call[0]) === "/api/image-edits");
    expect(editCall).toBeTruthy();
    expect(JSON.parse(String((editCall![1] as RequestInit).body))).toEqual({
      imageUrl: "/api/generated-images/3/file?sig=abc",
      prompt: "把背景换成米白色",
      title: "产品图",
    });

    // First poll issued right away.
    const pollCount = () => fetchMock.mock.calls.filter((call) => String(call[0]).startsWith("/api/image-jobs/")).length;
    expect(pollCount()).toBe(1);

    // A second poll fires while mounted...
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
    expect(pollCount()).toBe(2);

    // ...but unmounting aborts the scope: no more polls ever.
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS * 10);
    expect(pollCount()).toBe(2);
  });

  it("shows 改图失败 with the backend error text verbatim", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/image-edits") {
        return jsonResponse(400, { error: "请填写改图提示词。" });
      }
      throw new Error(`unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = await mountView();

    await wrapper.find('textarea[name="prompt"]').setValue("加一个夏日氛围");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find('[data-test="job-error"]').text()).toBe("改图失败：请填写改图提示词。");
  });
});
