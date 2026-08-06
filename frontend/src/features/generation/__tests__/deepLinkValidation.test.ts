import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "@/features/ideas/views/IdeasView.vue";
import {
  callsTo,
  installFetchMock,
  jsonResponse,
  makeBrandDetail,
  makeBrandSummary,
  makeTestRouter,
  makeTrend,
  type FetchHandler,
} from "@/features/trends/__tests__/insightsTestUtils";

function baseHandler(overrides: FetchHandler = () => undefined): FetchHandler {
  return (url, init) => {
    const method = String(init?.method || "GET");
    if (method === "GET" && url === "/api/brands?summary=1") {
      return jsonResponse(200, { brands: [makeBrandSummary()] });
    }
    if (method === "GET" && url === "/api/brands/7") {
      return jsonResponse(200, { brand: makeBrandDetail([makeTrend(501)]) });
    }
    if (method === "GET" && url === "/api/product-images") {
      return jsonResponse(200, { images: [] });
    }
    if (method === "GET" && url === "/api/history") {
      return jsonResponse(200, { generations: [] });
    }
    if (method === "GET" && url === "/api/session") {
      return jsonResponse(200, { user: { id: "1", name: "测试用户", phone: "13800000000", credits: 5 } });
    }
    if (method === "POST" && /\/ideas\/0\/image$/.test(url)) {
      return jsonResponse(202, { jobId: "ab12cd34ef", user: { id: "1" } });
    }
    if (method === "GET" && url.startsWith("/api/image-jobs/")) {
      return jsonResponse(200, {
        status: "completed",
        imageConcept: { imageUrl: "/api/generated-images/1/file?sig=x", title: "图" },
        generationId: 1,
        persisted: true,
      });
    }
    return overrides(url, init);
  };
}

async function mountWithDeepLink(query: Record<string, string>) {
  const fetchMock = installFetchMock(baseHandler());
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
  auth.sessionLoaded = true;
  const router = makeTestRouter();
  await router.push({ name: "ideas", query });
  await router.isReady();
  const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  await flushPromises();
  return { wrapper, fetchMock, router };
}

describe("deep link strict validation (zero-POST gate)", () => {
  let wrapper: ReturnType<typeof mount> | null = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("invalid brand deep link opens no dialog and makes zero generation POSTs", async () => {
    const mounted = await mountWithDeepLink({ brandId: "999", trendId: "501", ideaIndex: "0", action: "moments" });
    wrapper = mounted.wrapper;

    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="deep-link-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="deep-link-error"]').text()).toContain("失效");
    const posts = callsTo(mounted.fetchMock, "/ideas/0/image");
    expect(posts).toHaveLength(0);
  });

  it("cross-brand / invalid trend deep link opens no dialog and makes zero generation POSTs", async () => {
    const mounted = await mountWithDeepLink({ brandId: "7", trendId: "999", ideaIndex: "0", action: "moments" });
    wrapper = mounted.wrapper;

    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="deep-link-error"]').exists()).toBe(true);
    const posts = callsTo(mounted.fetchMock, "/ideas/0/image");
    expect(posts).toHaveLength(0);
  });

  it("out-of-range ideaIndex opens no dialog and makes zero generation POSTs", async () => {
    const mounted = await mountWithDeepLink({ brandId: "7", trendId: "501", ideaIndex: "9", action: "moments" });
    wrapper = mounted.wrapper;

    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="deep-link-error"]').exists()).toBe(true);
    const posts = callsTo(mounted.fetchMock, "/ideas/0/image");
    expect(posts).toHaveLength(0);
  });

  it("valid deep link opens the dialog and submits exactly one generation POST", async () => {
    const mounted = await mountWithDeepLink({ brandId: "7", trendId: "501", ideaIndex: "0", action: "moments" });
    wrapper = mounted.wrapper;

    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="deep-link-error"]').exists()).toBe(false);
    const posts = callsTo(mounted.fetchMock, "/ideas/0/image");
    expect(posts).toHaveLength(1);
  });
});
