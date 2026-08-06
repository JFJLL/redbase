import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import { resetImageJobRecoveryForTests, useImageJobRecovery } from "../composables/useImageJobRecovery";
import RecoveredJobBanner from "../components/RecoveredJobBanner.vue";
import { IMAGE_JOB_POLL_INTERVAL_MS } from "../api";
import { jsonResponse } from "@/features/trends/__tests__/insightsTestUtils";

/** 恢复提示展示层契约：常驻 banner 移除后，终态事件只以自动消失的 toast 呈现。 */
function activeJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "ab12cd34ef",
    status: "pending",
    type: "moments",
    brandId: 7,
    trendId: 501,
    ideaIndex: 0,
    aspectRatio: "3:4",
    creditEventId: null,
    slide: {},
    ...overrides,
  };
}

describe("RecoveredJobBanner as auto-dismissing toast presenter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let wrapper: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
    auth.sessionLoaded = true;
    resetImageJobRecoveryForTests();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    resetImageJobRecoveryForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function mountBanner() {
    wrapper = mount(RecoveredJobBanner);
    await flushPromises();
    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();
    return { wrapper, recovery };
  }

  function failedJobResponse(jobId: string, error = "生成通道拥堵") {
    return (url: string): Response => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: [activeJob({ jobId, type: "moments" })] });
      }
      if (url === `/api/image-jobs/${jobId}`) {
        return jsonResponse(200, { status: "failed", error });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
  }

  it("shows one auto-dismissing failure toast instead of any persistent recovery banner", async () => {
    installFetch(failedJobResponse("job-fail-1"));
    const { wrapper } = await mountBanner();

    // 首个轮询在挂载后立即完成：失败事件于 t≈0 发生，600ms 聚合窗口后弹出 toast。
    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();

    // 常驻 banner、任务列表、“停止恢复”、“知道了”全部不得出现。
    expect(wrapper.find(".recovered-job-banner").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("生图任务恢复");
    expect(wrapper.text()).not.toContain("停止恢复");
    expect(wrapper.text()).not.toContain("知道了");

    const toast = wrapper.find('[data-test="recovered-job-toast"]');
    expect(toast.exists()).toBe(true);
    expect(toast.text()).toContain("朋友圈图生成失败，积分已退回。");
    expect(toast.attributes("role")).toBe("alert");

    // 3–5 秒后自动消失，不残留。
    await vi.advanceTimersByTimeAsync(4500);
    await flushPromises();
    expect(wrapper.find('[data-test="recovered-job-toast"]').exists()).toBe(false);
  });

  it("merges several simultaneous task failures into a single summary toast", async () => {
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: ["job-a", "job-b", "job-c"].map((jobId) => activeJob({ jobId, type: "moments" })),
        });
      }
      if (/^\/api\/image-jobs\/job-[abc]$/.test(url)) {
        return jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { wrapper } = await mountBanner();

    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();

    expect(wrapper.findAll('[data-test="recovered-job-toast"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="recovered-job-toast"]').text()).toContain(
      "3 个生图任务生成失败，积分已退回。",
    );
  });

  it("reports a failed carousel group with one per-group toast, not per slide", async () => {
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: [
            activeJob({ jobId: "slide-0", type: "xhsCarouselSlide", slideIndex: 0, carouselGroupId: "grp-1", creditEventId: 7, carouselTitle: "夏日旅行vlog", slide: { slideIndex: 0, prompt: "p0" } }),
            activeJob({ jobId: "slide-1", type: "xhsCarouselSlide", slideIndex: 1, carouselGroupId: "grp-1", creditEventId: 7, carouselTitle: "夏日旅行vlog", slide: { slideIndex: 1, prompt: "p1" } }),
          ],
        });
      }
      if (url === "/api/image-jobs/slide-0") {
        return jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
      }
      if (url === "/api/image-jobs/slide-1") {
        return jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/api/generated-images/1/file?sig=x" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { wrapper } = await mountBanner();

    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();

    expect(wrapper.findAll('[data-test="recovered-job-toast"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="recovered-job-toast"]').text()).toContain(
      "夏日旅行vlog组图生成失败，积分已退回。",
    );
  });

  it("shows a transient success toast for completed recovery with no persistent UI", async () => {
    let polls = 0;
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: [activeJob({ jobId: "job-ok", type: "moments" })] });
      }
      if (url === "/api/image-jobs/job-ok") {
        polls += 1;
        return polls === 1
          ? jsonResponse(200, { status: "pending" })
          : jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/api/generated-images/1/file?sig=x" }, generationId: 1, persisted: true });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { wrapper } = await mountBanner();

    // 首个轮询返回 pending，完成事件在 5s 后的第二次轮询出现。
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS + 800);
    await flushPromises();

    expect(wrapper.find(".recovered-job-banner").exists()).toBe(false);
    const toast = wrapper.find('[data-test="recovered-job-toast"]');
    expect(toast.exists()).toBe(true);
    expect(toast.text()).toContain("已完成，已写入历史");
    expect(toast.attributes("role")).toBe("status");

    await vi.advanceTimersByTimeAsync(4500);
    await flushPromises();
    expect(wrapper.find('[data-test="recovered-job-toast"]').exists()).toBe(false);
  });

  it("shows the raw terminal reason for 404/401 failures instead of claiming a refund", async () => {
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: [activeJob({ jobId: "job-404", type: "moments" })] });
      }
      if (url === "/api/image-jobs/job-404") {
        return jsonResponse(404, { error: "Not found" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { wrapper } = await mountBanner();

    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();

    const toast = wrapper.find('[data-test="recovered-job-toast"]');
    expect(toast.exists()).toBe(true);
    expect(toast.text()).toContain("不存在或无权访问");
    expect(toast.text()).not.toContain("积分已退回");
  });

  it("merges several no-refund 404 task failures into one neutral summary", async () => {
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: ["j404a", "j404b", "j404c"].map((jobId) => activeJob({ jobId, type: "moments" })),
        });
      }
      if (/^\/api\/image-jobs\/j404[abc]$/.test(url)) {
        return jsonResponse(404, { error: "Not found" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { wrapper } = await mountBanner();

    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();

    expect(wrapper.findAll('[data-test="recovered-job-toast"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="recovered-job-toast"]').text()).toContain(
      "3 个生图任务已停止恢复。",
    );
    expect(wrapper.find('[data-test="recovered-job-toast"]').text()).not.toContain("积分已退回");
  });

  it("reports a carousel group with a 404 slide without claiming a refund", async () => {
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: [
            activeJob({ jobId: "g404a", type: "xhsCarouselSlide", slideIndex: 0, carouselGroupId: "grp-404", creditEventId: 9, carouselTitle: "露营vlog", slide: { slideIndex: 0, prompt: "p0" } }),
            activeJob({ jobId: "g404b", type: "xhsCarouselSlide", slideIndex: 1, carouselGroupId: "grp-404", creditEventId: 9, carouselTitle: "露营vlog", slide: { slideIndex: 1, prompt: "p1" } }),
          ],
        });
      }
      if (url === "/api/image-jobs/g404a") {
        return jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/api/generated-images/0/file?sig=x" } });
      }
      if (url === "/api/image-jobs/g404b") {
        return jsonResponse(404, { error: "Not found" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { wrapper } = await mountBanner();

    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();

    const toast = wrapper.find('[data-test="recovered-job-toast"]');
    expect(toast.exists()).toBe(true);
    expect(toast.text()).toContain("已停止恢复");
    expect(toast.text()).not.toContain("积分已退回");
  });

  it("does not re-toast an already-terminal state on rescan or route changes", async () => {
    let scanCount = 0;
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        scanCount += 1;
        // 终态任务已从服务端 active 列表消失；rescan 只带回空列表（不再轮询旧任务）。
        return jsonResponse(200, { jobs: scanCount === 1 ? [activeJob({ jobId: "job-once", type: "moments" })] : [] });
      }
      if (url === "/api/image-jobs/job-once") {
        return jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { wrapper, recovery } = await mountBanner();

    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();
    expect(wrapper.findAll('[data-test="recovered-job-toast"]')).toHaveLength(1);

    // 等 toast 消失后，路由变化触发的 rescan 不得再次弹同一终态。
    await vi.advanceTimersByTimeAsync(4500);
    await flushPromises();
    expect(wrapper.find('[data-test="recovered-job-toast"]').exists()).toBe(false);

    recovery.rescan();
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS + 800);
    await flushPromises();
    expect(wrapper.find('[data-test="recovered-job-toast"]').exists()).toBe(false);
    expect(scanCount).toBeGreaterThanOrEqual(2);
  });

  it("renders no persistent banner and no toast while scanning or polling", async () => {
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: [activeJob({ jobId: "job-pending", type: "moments" })] });
      }
      if (url === "/api/image-jobs/job-pending") {
        return jsonResponse(200, { status: "pending" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { wrapper } = await mountBanner();

    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
    await flushPromises();

    expect(wrapper.find(".recovered-job-banner").exists()).toBe(false);
    expect(wrapper.find('[data-test="recovered-job-toast"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("生图任务恢复");
  });

  it("keeps zero creation POSTs while recovery polling and toast presentation run", async () => {
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: [activeJob({ jobId: "job-post-free", type: "moments" })] });
      }
      if (url === "/api/image-jobs/job-post-free") {
        return jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { wrapper } = await mountBanner();

    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();
    expect(wrapper.find('[data-test="recovered-job-toast"]').exists()).toBe(true);

    const posts = fetchMock.mock.calls.filter(
      ([, init]) => String((init as RequestInit | undefined)?.method || "GET") === "POST",
    );
    expect(posts).toHaveLength(0);
  });
});
