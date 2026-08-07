import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import ImageEditPanel from "../components/ImageEditPanel.vue";
import HistoryView from "@/features/history/views/HistoryView.vue";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: { template: "<div />" } },
      { path: "/login", name: "login", component: { template: "<div />" } },
    ],
  });
}

describe("ImageEditPanel shared edit capability", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("submits the full edit contract (generationId/parentEditId/slideIndex) and reports success", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 8 };
    let polls = 0;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET");
      if (method === "POST" && url === "/api/image-edits") {
        return jsonResponse(202, { jobId: "ab12cd34ef", user: { id: "1", credits: 7 } });
      }
      if (method === "GET" && url === "/api/image-jobs/ab12cd34ef") {
        polls += 1;
        return jsonResponse(200, {
          status: "completed",
          imageConcept: { imageUrl: "/api/generated-images/9/edit/file?sig=x", title: "改图结果" },
          generationId: 9,
          persisted: true,
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const wrapper = mount(ImageEditPanel, {
      props: {
        target: {
          imageUrl: "/api/generated-images/9/file?sig=orig",
          title: "历史图",
          aspectRatio: "3:4",
          generationId: 9,
          parentEditId: "ab12cd33",
          slideIndex: 1,
        },
      },
      global: { plugins: [pinia] },
    });

    await wrapper.find('[data-test="image-edit-prompt"]').setValue("把背景换成夜晚");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === "/api/image-edits" && String((init as RequestInit | undefined)?.method || "GET") === "POST",
    );
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      imageUrl: "/api/generated-images/9/file?sig=orig",
      prompt: "把背景换成夜晚",
      title: "历史图",
      aspectRatio: "3:4",
      generationId: 9,
      parentEditId: "ab12cd33",
      slideIndex: 1,
    });
    expect(wrapper.find('[data-test="image-edit-status"]').text()).toContain("改图完成");
    expect(wrapper.emitted("edited")).toHaveLength(1);
    expect(auth.user?.credits).toBe(7);
  });

  it("surfaces backend errors without emitting edited", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAuthStore().user = { id: "1", name: "测试用户", phone: "13800000000", credits: 8 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (String(init?.method || "GET") === "POST" && url === "/api/image-edits") {
          return jsonResponse(402, { error: "积分不足" });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const wrapper = mount(ImageEditPanel, {
      props: { target: { imageUrl: "/api/generated-images/1/file?sig=x", title: "图" } },
      global: { plugins: [pinia] },
    });
    await wrapper.find('[data-test="image-edit-prompt"]').setValue("换个风格");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="image-edit-error"]').text()).toContain("积分不足");
    expect(wrapper.emitted("edited")).toBeUndefined();
  });
});

describe("HistoryView edit flow (ordinary image, carousel slide, edit history chain)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const HISTORY = [
    {
      id: 1,
      type: "moments",
      cardTitle: "露营朋友圈图",
      brandName: "品牌A",
      brandId: 7,
      channelLabel: "朋友圈",
      createdAt: "2026-07-20T08:00:00.000Z",
      previewUrl: "/api/generated-images/1/file?sig=aaa",
      payload: { caption: "露营去咯", aspectRatio: "3:4" },
    },
    {
      id: 2,
      type: "xhsCarousel",
      cardTitle: "护肤小红书组图",
      brandName: "品牌B",
      brandId: 8,
      channelLabel: "小红书",
      createdAt: "2026-07-21T08:00:00.000Z",
      previewUrl: "/api/generated-images/2/0/file?sig=bbb",
      payload: {
        aspectRatio: "3:4",
        slides: [
          { title: "第1页", imageUrl: "/api/generated-images/2/0/file?sig=bbb" },
          { title: "第2页", imageUrl: "/api/generated-images/2/1/file?sig=ccc" },
        ],
        editHistory: [
          {
            id: "edit-1",
            parentEditId: "",
            imageUrl: "/api/generated-images/2/edit-1/file?sig=ddd",
            title: "改图一",
          },
        ],
      },
    },
    {
      id: 3,
      type: "xhsCarousel",
      cardTitle: "部分恢复组图",
      brandName: "品牌C",
      brandId: 9,
      channelLabel: "小红书",
      createdAt: "2026-07-22T08:00:00.000Z",
      previewUrl: "/api/generated-images/3/1/file?sig=p2",
      payload: {
        aspectRatio: "3:4",
        slides: [
          {},
          { title: "第2页", imageUrl: "/api/generated-images/3/1/file?sig=p2" },
          {},
          { title: "第4页", imageUrl: "/api/generated-images/3/3/file?sig=p4" },
        ],
        editHistory: [],
      },
    },
  ];

  async function mountHistory() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 8 };
    auth.sessionLoaded = true;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET");
      if (url.startsWith("/api/brands")) return jsonResponse(200, { brands: [{ id: 7, name: "品牌A" }] });
      if (url.startsWith("/api/history")) return jsonResponse(200, { generations: HISTORY });
      if (url === "/api/session") return jsonResponse(200, { user: { id: "1", credits: 8 } });
      if (method === "POST" && url === "/api/image-edits") {
        return jsonResponse(202, { jobId: "ab12cd34ef", user: { id: "1", credits: 7 } });
      }
      if (method === "GET" && url.startsWith("/api/image-jobs/ab12cd34ef")) {
        return jsonResponse(200, {
          status: "completed",
          imageConcept: { imageUrl: "/api/generated-images/99/edit/file?sig=new", title: "改图新结果" },
          generationId: 99,
          persisted: true,
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = makeRouter();
    await router.push("/");
    await router.isReady();
    const wrapper = mount(HistoryView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, auth };
  }

  it("edits an ordinary history image with its generationId", async () => {
    const { wrapper } = await mountHistory();
    await wrapper.findAll('[data-test="history-detail"]')[0].trigger("click");
    await flushPromises();

    await wrapper.find('[data-test="history-edit-open"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="image-edit-prompt"]').setValue("改成夜晚露营");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.generationId).toBe(1);
    expect(body.parentEditId).toBeUndefined();
    expect(wrapper.find('[data-test="image-edit-status"]').text()).toContain("改图完成");
  });

  it("edits a specific carousel slide with its slideIndex and generationId", async () => {
    const { wrapper } = await mountHistory();
    await wrapper.findAll('[data-test="history-detail"]')[1].trigger("click");
    await flushPromises();

    await wrapper.find('[data-test="history-slide-tab-1"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="history-edit-open"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="image-edit-prompt"]').setValue("改第二页构图");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.generationId).toBe(2);
    expect(body.slideIndex).toBe(1);
    expect(body.imageUrl).toBe("/api/generated-images/2/1/file?sig=ccc");
  });

  it("defaults a carousel detail to its first real slide and preserves slideIndex 0", async () => {
    const { wrapper } = await mountHistory();
    await wrapper.findAll('[data-test="history-detail"]')[1].trigger("click");
    await flushPromises();

    await wrapper.find('[data-test="history-edit-open"]').trigger("click");
    await wrapper.find('[data-test="image-edit-prompt"]').setValue("直接修改首图");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.generationId).toBe(2);
    expect(body.slideIndex).toBe(0);
    expect(body.imageUrl).toBe("/api/generated-images/2/0/file?sig=bbb");
  });

  it("keeps source slide indices when empty carousel slots are filtered from display", async () => {
    const { wrapper } = await mountHistory();
    await wrapper.findAll('[data-test="history-detail"]')[2].trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-test="history-slide-tab-3"]').exists()).toBe(true);
    await wrapper.find('[data-test="history-slide-tab-3"]').trigger("click");
    await wrapper.find('[data-test="history-edit-open"]').trigger("click");
    await wrapper.find('[data-test="image-edit-prompt"]').setValue("修改真实第四页");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.generationId).toBe(3);
    expect(body.slideIndex).toBe(3);
    expect(body.imageUrl).toBe("/api/generated-images/3/3/file?sig=p4");
  });

  it("continues editing from an edit-history result with parentEditId chaining", async () => {
    const { wrapper } = await mountHistory();
    await wrapper.findAll('[data-test="history-detail"]')[1].trigger("click");
    await flushPromises();

    await wrapper.find('[data-test="history-edit-history-item-edit-1"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="image-edit-prompt"]').setValue("再改一版");
    await wrapper.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.generationId).toBe(2);
    expect(body.parentEditId).toBe("edit-1");
    expect(body.imageUrl).toBe("/api/generated-images/2/edit-1/file?sig=ddd");
  });

  it("renders the selected edit-history record's own inline panel while the main form steps aside", async () => {
    const { wrapper } = await mountHistory();
    await wrapper.findAll('[data-test="history-detail"]')[1].trigger("click");
    await flushPromises();

    await wrapper.find('[data-test="history-edit-history-item-edit-1"]').trigger("click");
    await flushPromises();

    const record = wrapper.find('[data-test="history-edit-history-item-edit-1"]');
    expect(record.find('[data-test="image-edit-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="history-edit-open"] [data-test="image-edit-panel"]').exists()).toBe(false);

    await record.find('[data-test="image-edit-prompt"]').setValue("沿历史结果再改");
    await record.find('[data-test="image-edit-submit"]').trigger("click");
    await flushPromises();

    const post = fetchMock.mock.calls.find(([url]) => String(url) === "/api/image-edits");
    const body = JSON.parse(String((post?.[1] as RequestInit | undefined)?.body || "{}")) as Record<string, unknown>;
    expect(body.parentEditId).toBe("edit-1");
    expect(body.generationId).toBe(2);
  });
});
