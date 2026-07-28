/**
 * 任务1：fileToDataUrl 账号隔离。
 * - shared fileToDataUrl 支持 AbortSignal：读取前预检、读取中 FileReader.abort()、
 *   读取完成后再次检查 signal.aborted。
 * - 文件读取进行中触发账号切换（notifyAuthReset）时，ProductImagePanel 必须
 *   不发出 POST /api/product-images，也不把图片写入素材列表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { fileToDataUrl } from "@/shared/utils/fileToDataUrl";
import { notifyAuthReset } from "@/shared/composables/useAbortScope";
import { isAbortError } from "@/shared/api/client";
import ProductImagePanel from "../components/ProductImagePanel.vue";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function waitMacrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
  }
}

describe("shared fileToDataUrl abort semantics", () => {
  it("resolves a data url without a signal", async () => {
    const file = new File(["hello"], "a.png", { type: "image/png" });
    const dataUrl = await fileToDataUrl(file);
    expect(dataUrl).toContain("data:");
  });

  it("rejects immediately with AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const file = new File(["hello"], "a.png", { type: "image/png" });
    const outcome = await fileToDataUrl(file, controller.signal).catch((error: unknown) => error);
    expect(isAbortError(outcome)).toBe(true);
  });

  it("aborts the FileReader mid-read and rejects with AbortError", async () => {
    const abortSpy = vi.spyOn(FileReader.prototype, "abort");
    try {
      const controller = new AbortController();
      const file = new File(["hello"], "a.png", { type: "image/png" });
      const pending = fileToDataUrl(file, controller.signal);
      // FileReader 的 load 事件在宏任务派发；此刻读取仍在进行中。
      controller.abort();
      const outcome = await pending.catch((error: unknown) => error);
      expect(isAbortError(outcome)).toBe(true);
      expect(abortSpy).toHaveBeenCalled();
    } finally {
      abortSpy.mockRestore();
    }
  });
});

describe("ProductImagePanel session-safe upload", () => {
  function makeRouter(): Router {
    return createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: { template: "<div />" } },
        { path: "/login", name: "login", component: { template: "<div />" } },
      ],
    });
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET" && url.split("?")[0] === "/api/product-images") {
        return jsonResponse(200, { images: [] });
      }
      if (method === "POST" && url === "/api/product-images") {
        return jsonResponse(201, {
          image: { id: 31, originalName: "switch.png", url: "/api/product-images/31/file?sig=s", sizeBytes: 100 },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mountPanel() {
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(ProductImagePanel, {
      props: { selectedIds: [] },
      global: { plugins: [createPinia(), router] },
    });
    await flushPromises();
    return wrapper;
  }

  function uploadPostCount(): number {
    return fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input) === "/api/product-images" &&
        String((init as RequestInit | undefined)?.method || "GET").toUpperCase() === "POST",
    ).length;
  }

  it("account switch during the file read never POSTs /api/product-images nor writes the list", async () => {
    const abortSpy = vi.spyOn(FileReader.prototype, "abort");
    try {
      const wrapper = await mountPanel();
      const input = wrapper.find('[data-test="product-image-upload"]');
      const file = new File(["switch-account-bytes"], "switch.png", { type: "image/png" });
      Object.defineProperty(input.element, "files", { value: [file], configurable: true });
      await input.trigger("change");

      // FileReader 仍在读取（load 事件在宏任务派发）：此刻切换账号。
      notifyAuthReset();
      await waitMacrotasks();

      expect(abortSpy).toHaveBeenCalled();
      expect(uploadPostCount()).toBe(0);
      // 不得把上一账号的文件写入素材列表 / 勾选集合。
      expect(wrapper.findAll(".image-item")).toHaveLength(0);
      expect(wrapper.emitted("update:selectedIds")).toBeUndefined();
    } finally {
      abortSpy.mockRestore();
    }
  });

  it("the same flow without an account switch does POST (control case)", async () => {
    const wrapper = await mountPanel();
    const input = wrapper.find('[data-test="product-image-upload"]');
    const file = new File(["normal-bytes"], "switch.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await waitMacrotasks();

    expect(uploadPostCount()).toBe(1);
    expect(wrapper.findAll(".image-item")).toHaveLength(1);
  });
});
