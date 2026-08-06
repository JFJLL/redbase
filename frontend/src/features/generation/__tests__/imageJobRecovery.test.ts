import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import { notifyAuthReset } from "@/shared/composables/useAbortScope";
import {
  resetImageJobRecoveryForTests,
  useImageJobRecovery,
} from "../composables/useImageJobRecovery";
import { IMAGE_JOB_POLL_INTERVAL_MS } from "../api";
import { jsonResponse } from "@/features/trends/__tests__/insightsTestUtils";

function completedJobResponse(imageUrl: string) {
  return jsonResponse(200, {
    status: "completed",
    imageConcept: { imageUrl, previewUrl: imageUrl, title: "生成图" },
    generationId: 1,
    persisted: true,
  });
}

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

describe("useImageJobRecovery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

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

  it("resumes polling active single-image jobs and never issues a creation POST", async () => {
    let polls = 0;
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: [activeJob({ jobId: "ab12cd34ef", type: "moments" })] });
      }
      if (url === "/api/image-jobs/ab12cd34ef") {
        polls += 1;
        return polls === 1 ? jsonResponse(200, { status: "pending" }) : completedJobResponse("/api/generated-images/1/file?sig=x");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.state.tasks).toHaveLength(1);
    expect(recovery.state.tasks[0].status).toBe("polling");

    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
    expect(recovery.state.tasks[0].status).toBe("completed");
    expect(recovery.state.tasks[0].imageUrl).toBe("/api/generated-images/1/file?sig=x");

    const posts = fetchMock.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.method || "GET") === "POST");
    expect(posts).toHaveLength(0);
  });

  it("auto-completes a recovered carousel group exactly once after all four slides are done", async () => {
    const slideJobs = [0, 1, 2, 3].map((index) =>
      activeJob({
        jobId: `ab12cd34e${index}`,
        type: "xhsCarouselSlide",
        slideIndex: index,
        carouselGroupId: "group-recovery-1",
        carouselTitle: "恢复组图",
        publishTitle: "发布标题",
        publishCaption: "发布文案",
        caption: "文案",
        creditEventId: 42,
        aspectRatio: "3:4",
        slide: { slideIndex: index, pageLabel: `第 ${index + 1} 张`, prompt: `提示词 ${index}` },
      }),
    );
    let completeCalls = 0;
    let completeBody: Record<string, unknown> | null = null;
    installFetch((url, init): Response | Promise<Response> => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: slideJobs });
      }
      if (method === "GET" && url.startsWith("/api/image-jobs/ab12cd34e")) {
        const index = Number(url.slice(-1));
        return completedJobResponse(`/api/generated-images/${index}/file?sig=x`);
      }
      if (method === "POST" && url === "/api/brands/7/trends/501/ideas/0/xhs-carousel/complete") {
        completeCalls += 1;
        completeBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
        return jsonResponse(200, { generation: { id: 1 }, user: { id: "1" } });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);

    expect(completeCalls).toBe(1);
    const pack = (completeBody as Record<string, unknown> | null)?.carouselPack as Record<string, unknown> | undefined;
    expect(pack?.carouselGroupId).toBe("group-recovery-1");
    expect((pack?.slides as Array<Record<string, unknown>>).length).toBe(4);
    expect((completeBody as Record<string, unknown> | null)?.creditEventId).toBe(42);
    expect(recovery.state.groups[0].completed).toBe(true);

    // 再次扫描不得重复 complete（同组已完成即跳过）。
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS * 2);
    expect(completeCalls).toBe(1);
  });

  it("never calls complete for a partial carousel group", async () => {
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: [
            activeJob({ jobId: "ab12cd34e0", type: "xhsCarouselSlide", slideIndex: 0, carouselGroupId: "g-partial", creditEventId: 43, slide: { slideIndex: 0, prompt: "p0" } }),
            activeJob({ jobId: "ab12cd34e1", type: "xhsCarouselSlide", slideIndex: 1, carouselGroupId: "g-partial", creditEventId: 43, slide: { slideIndex: 1, prompt: "p1" } }),
          ],
        });
      }
      if (method === "GET" && url.startsWith("/api/image-jobs/ab12cd34e")) {
        return completedJobResponse(`/api/generated-images/${url.slice(-1)}/file?sig=x`);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);

    expect(recovery.state.groups[0].completed).toBe(false);
    const completes = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes("/xhs-carousel/complete") && String((init as RequestInit | undefined)?.method || "GET") === "POST",
    );
    expect(completes).toHaveLength(0);
  });

  it("aborts all recovery polling and clears state on auth reset", async () => {
    let polls = 0;
    installFetch((url) => {
      if (url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: [activeJob({ jobId: "ab12cd34ef", type: "moments" })] });
      }
      if (url === "/api/image-jobs/ab12cd34ef") {
        polls += 1;
        return jsonResponse(200, { status: "pending" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.state.tasks).toHaveLength(1);

    notifyAuthReset();
    expect(recovery.state.tasks).toHaveLength(0);
    const pollsAfterReset = polls;
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS * 3);
    expect(polls).toBe(pollsAfterReset);
  });

  it("an in-flight active scan never registers tasks after logout (account switch race)", async () => {
    let resolveScan!: (response: Response) => void;
    const scanGate = new Promise<Response>((resolve) => {
      resolveScan = resolve;
    });
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") return scanGate;
      if (method === "GET" && url.startsWith("/api/image-jobs/")) {
        return jsonResponse(200, { status: "pending" });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);

    // 扫描在途时登出（auth reset）：随后到达的响应不得注册旧账号任务。
    notifyAuthReset();
    resolveScan(jsonResponse(200, { jobs: [activeJob({ jobId: "ab12cd34ef", type: "moments" })] }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(recovery.state.tasks).toHaveLength(0);
    expect(recovery.state.groups).toHaveLength(0);
    const polls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/image-jobs/ab12cd34ef"));
    expect(polls).toHaveLength(0);
  });

  it("a 404 during polling becomes a terminal failed task instead of retrying forever", async () => {
    let polls = 0;
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: [activeJob({ jobId: "ab12cd34ef", type: "moments" })] });
      }
      if (method === "GET" && url === "/api/image-jobs/ab12cd34ef") {
        polls += 1;
        return jsonResponse(404, { error: "Not found" });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(recovery.state.tasks[0].status).toBe("failed");
    expect(recovery.state.tasks[0].error).toContain("不存在");
    const pollsAfter = polls;
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS * 3);
    expect(polls).toBe(pollsAfter);
  });

  it("dismissing a task stops its background polling", async () => {
    let polls = 0;
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        return jsonResponse(200, { jobs: [activeJob({ jobId: "ab12cd34ef", type: "moments" })] });
      }
      if (method === "GET" && url === "/api/image-jobs/ab12cd34ef") {
        polls += 1;
        return jsonResponse(200, { status: "pending" });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.state.tasks).toHaveLength(1);

    recovery.dismissTask("ab12cd34ef");
    expect(recovery.state.tasks).toHaveLength(0);
    const pollsAfter = polls;
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS * 3);
    expect(polls).toBe(pollsAfter);
  });

  it("a partial carousel group whose slides are all terminal becomes a dismissible error", async () => {
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: [
            activeJob({ jobId: "ab12cd34e0", type: "xhsCarouselSlide", slideIndex: 0, carouselGroupId: "g-partial2", creditEventId: 44, slide: { slideIndex: 0, prompt: "p0" } }),
            activeJob({ jobId: "ab12cd34e1", type: "xhsCarouselSlide", slideIndex: 1, carouselGroupId: "g-partial2", creditEventId: 44, slide: { slideIndex: 1, prompt: "p1" } }),
          ],
        });
      }
      if (method === "GET" && url.startsWith("/api/image-jobs/ab12cd34e")) {
        const index = url.slice(-1);
        return index === "0"
          ? jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/api/generated-images/0/file?sig=x" } })
          : jsonResponse(200, { status: "failed", error: "生成通道拥堵" });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);

    const group = recovery.state.groups[0];
    expect(group.completed).toBe(false);
    expect(group.error).toContain("失败");
    // 终态组图可关闭：dismiss 后横幅不再渲染该组。
    recovery.dismissGroup("g-partial2");
    expect(recovery.state.groups).toHaveLength(0);
  });

  it("an all-completed partial carousel group (<4 pages) becomes a dismissible error", async () => {
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: [
            activeJob({ jobId: "ab12cd34e0", type: "xhsCarouselSlide", slideIndex: 0, carouselGroupId: "g-partial3", creditEventId: 45, slide: { slideIndex: 0, prompt: "p0" } }),
            activeJob({ jobId: "ab12cd34e1", type: "xhsCarouselSlide", slideIndex: 1, carouselGroupId: "g-partial3", creditEventId: 45, slide: { slideIndex: 1, prompt: "p1" } }),
          ],
        });
      }
      if (method === "GET" && url.startsWith("/api/image-jobs/ab12cd34e")) {
        return jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/api/generated-images/0/file?sig=x" } });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);

    const group = recovery.state.groups[0];
    expect(group.completed).toBe(false);
    expect(group.error).toContain("仅完成 2/4");
  });

  it("a rescan requested during an in-flight scan is queued and picks up new jobs", async () => {
    let scanCount = 0;
    let resolveFirst!: (response: Response) => void;
    const firstGate = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        scanCount += 1;
        if (scanCount === 1) return firstGate;
        return jsonResponse(200, { jobs: [activeJob({ jobId: "ab12cd34ef", type: "moments" })] });
      }
      if (method === "GET" && url.startsWith("/api/image-jobs/ab12cd34ef")) {
        return jsonResponse(200, { status: "pending" });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    recovery.rescan(); // 扫描在途：应排队
    resolveFirst(jsonResponse(200, { jobs: [] }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(scanCount).toBe(2);
    expect(recovery.state.tasks).toHaveLength(1);
  });

  it("dismissed polling tasks are not re-registered by later rescans", async () => {
    let scanCount = 0;
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        scanCount += 1;
        return jsonResponse(200, { jobs: [activeJob({ jobId: "ab12cd34ef", type: "moments" })] });
      }
      if (method === "GET" && url.startsWith("/api/image-jobs/ab12cd34ef")) {
        return jsonResponse(200, { status: "pending" });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.state.tasks).toHaveLength(1);
    recovery.dismissTask("ab12cd34ef");
    expect(recovery.state.tasks).toHaveLength(0);

    recovery.rescan();
    await vi.advanceTimersByTimeAsync(0);
    expect(scanCount).toBe(2);
    expect(recovery.state.tasks).toHaveLength(0);
  });

  it("a 404 inside a carousel group finalizes the group as a dismissible error", async () => {
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: [
            activeJob({ jobId: "ab12cd34e0", type: "xhsCarouselSlide", slideIndex: 0, carouselGroupId: "g-404", creditEventId: 46, slide: { slideIndex: 0, prompt: "p0" } }),
            activeJob({ jobId: "ab12cd34e1", type: "xhsCarouselSlide", slideIndex: 1, carouselGroupId: "g-404", creditEventId: 46, slide: { slideIndex: 1, prompt: "p1" } }),
          ],
        });
      }
      if (method === "GET" && url === "/api/image-jobs/ab12cd34e0") {
        return jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/api/generated-images/0/file?sig=x" } });
      }
      if (method === "GET" && url === "/api/image-jobs/ab12cd34e1") {
        return jsonResponse(404, { error: "Not found" });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);

    const group = recovery.state.groups[0];
    expect(group.completed).toBe(false);
    expect(group.error).toContain("失败");
  });

  it("an excellentRemix carousel group with 4/4 completed slides is finalized as completed", async () => {
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: [0, 1, 2, 3].map((index) =>
            activeJob({
              jobId: `ab12cd38e${index}`,
              type: "xhsCarouselSlide",
              slideIndex: index,
              carouselGroupId: "g-remix",
              creditEventId: 47,
              excellentRemix: true,
              slide: { slideIndex: index, prompt: `p${index}` },
            }),
          ),
        });
      }
      if (method === "GET" && url.startsWith("/api/image-jobs/ab12cd38e")) {
        return jsonResponse(200, { status: "completed", imageConcept: { imageUrl: `/api/generated-images/${url.slice(-1)}/file?sig=x` } });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);

    const group = recovery.state.groups[0];
    expect(group.completed).toBe(true);
    expect(group.error).toBe("");
  });

  it("terminal group members from the snapshot make the banner count accurate", async () => {
    installFetch((url, init) => {
      const method = String(init?.method || "GET");
      if (method === "GET" && url === "/api/image-jobs/active") {
        return jsonResponse(200, {
          jobs: [
            // 第 0 页已完成（服务端快照回填终态成员），第 1 页仍在 running。
            activeJob({ jobId: "ab12cd43e0", status: "completed", type: "xhsCarouselSlide", slideIndex: 0, carouselGroupId: "g-backfill2", creditEventId: 48, imageUrl: "/api/generated-images/0/file?sig=x", slide: { slideIndex: 0, prompt: "p0" } }),
            activeJob({ jobId: "ab12cd43e1", status: "running", type: "xhsCarouselSlide", slideIndex: 1, carouselGroupId: "g-backfill2", creditEventId: 48, slide: { slideIndex: 1, prompt: "p1" } }),
          ],
        });
      }
      if (method === "GET" && url === "/api/image-jobs/ab12cd43e1") {
        return jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/api/generated-images/1/file?sig=x" } });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const recovery = useImageJobRecovery();
    recovery.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(IMAGE_JOB_POLL_INTERVAL_MS);
    const group = recovery.state.groups[0];
    // 快照终态页 + 轮询页全部完成后：计数准确为 2/4 并终态化。
    expect(group.slides.filter((slide) => slide.status === "completed")).toHaveLength(2);
    expect(group.error).toContain("仅完成 2/4");
  });
});
