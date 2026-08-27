/**
 * 真实入口测试装配：挂载 IdeasView + IdeaGenerationDialog（/app/ideas 语义），
 * 替代已删除的 GenerationView 死页面测试。仅 mock 全局 fetch。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { useAuthStore } from "@/shared/stores/auth";
import IdeasView from "@/features/ideas/views/IdeasView.vue";
import {
  installFetchMock,
  jsonResponse,
  type FetchHandler,
} from "@/features/trends/__tests__/insightsTestUtils";

export function makeIdeasRouter(): Router {
  const Stub = { template: "<div />" };
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: Stub },
      { path: "/ideas", name: "ideas", component: Stub },
      { path: "/generation", name: "generation", redirect: (to) => ({ name: "ideas", query: to.query }) },
      { path: "/login", name: "login", component: Stub },
    ],
  });
}

export interface IdeasFlowOptions {
  brandId?: number;
  brandDetail?: unknown;
  brandSummaries?: unknown;
  productImages?: unknown;
  credits?: number;
  videoScriptUserCredits?: number;
  /** 命中优先：返回 Response 则短路；返回 undefined 继续走默认契约。 */
  overrides?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
}

const DEFAULT_COMPLETED = {
  status: "completed",
  imageConcept: {
    title: "生成标题",
    caption: "文案",
    visualDirection: "视觉方向",
    style: "风格",
    composition: "构图",
    imageUrl: "/api/generated-images/1/file?sig=z",
  },
  generationId: 1,
  persisted: true,
};

/** 覆盖内容选题页 + 生成对话框全链路（品牌/趋势/选题由 brandDetail 提供）。 */
export function makeIdeasFlowHandler(
  options: IdeasFlowOptions = {},
): (url: string, init?: RequestInit) => Response | Promise<Response> | undefined {
  const brandId = options.brandId ?? 1;
  return (url, init) => {
    const method = String(init?.method || "GET");
    const path = url.split("?")[0];
    const overridden = options.overrides?.(url, init);
    if (overridden) return overridden;
    if (method === "GET" && path === "/api/brands") {
      return jsonResponse(200, options.brandSummaries ?? { brands: [{ id: brandId, name: "测试品牌", profileType: "brand" }] });
    }
    if (method === "GET" && path === `/api/brands/${brandId}`) {
      return jsonResponse(200, options.brandDetail ?? { brand: { id: brandId, name: "测试品牌", profileType: "brand", logo: null, trends: [] } });
    }
    if (method === "GET" && path === "/api/product-images") {
      return jsonResponse(200, options.productImages ?? { images: [] });
    }
    if (method === "GET" && path === "/api/history") {
      return jsonResponse(200, { generations: [] });
    }
    if (method === "GET" && path === "/api/session") {
      return jsonResponse(200, { user: { id: "u1", credits: options.credits ?? 5 } });
    }
    if (method === "GET" && path === "/api/image-jobs/active") {
      return jsonResponse(200, { jobs: [] });
    }
    if (method === "POST" && /\/ideas\/\d+\/image$/.test(path)) {
      return jsonResponse(202, { jobId: "m1", user: { id: "u1" } });
    }
    if (method === "POST" && /\/wechat-long-image$/.test(path)) {
      return jsonResponse(202, { wechatPack: { title: "长图标题", publishTitle: "发布标题" }, jobId: "w1", user: { id: "u1" } });
    }
    if (method === "POST" && /\/style-image$/.test(path)) {
      return jsonResponse(202, { jobId: "st1", user: { id: "u1" } });
    }
    if (method === "POST" && /\/xhs-carousel\/preview$/.test(path)) {
      return jsonResponse(200, {
        carouselPack: {
          title: "组图标题",
          aspectRatio: "3:4",
          slides: [0, 1, 2, 3].map((index) => ({ title: `P${index + 1}`, visualDirection: `V${index + 1}` })),
        },
        user: { id: "u1" },
      });
    }
    if (method === "POST" && /\/xhs-carousel\/slides\/(\d+)$/.test(path)) {
      const slideIndex = Number(path.match(/\/slides\/(\d+)$/)?.[1] || 0);
      return jsonResponse(202, { slideJob: { slideIndex, jobId: `s${slideIndex}` }, creditEventId: 9, user: { id: "u1" } });
    }
    if (method === "POST" && /\/xhs-carousel\/complete$/.test(path)) {
      return jsonResponse(200, { generation: { id: 1 }, creditEventId: 9, user: { id: "u1" } });
    }
    if (method === "GET" && path.startsWith("/api/image-jobs/")) {
      return jsonResponse(200, DEFAULT_COMPLETED);
    }
    return undefined;
  };
}

export async function mountIdeasGeneration(
  options: IdeasFlowOptions = {},
  query: Record<string, string> = {},
): Promise<{
  wrapper: ReturnType<typeof mount>;
  router: Router;
  fetchMock: ReturnType<typeof installFetchMock>;
}> {
  const fetchMock = installFetchMock(makeIdeasFlowHandler(options) as FetchHandler);
  const router = makeIdeasRouter();
  await router.push({ name: "ideas", query });
  await router.isReady();
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = { id: "1", name: "测试用户", phone: "13800000000", credits: 5 };
  auth.sessionLoaded = true;
  const wrapper = mount(IdeasView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  await flushPromises();
  return { wrapper, router, fetchMock };
}

/** 安装全局 fetch（流程契约 handler），返回 mock 供断言。 */
export function installFlowFetch(options: IdeasFlowOptions = {}): ReturnType<typeof installFetchMock> {
  return installFetchMock(makeIdeasFlowHandler(options) as FetchHandler);
}

export function postCalls(
  fetchMock: ReturnType<typeof installFetchMock>,
  urlPrefix: string,
): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      const url = String(input);
      return String((init as RequestInit | undefined)?.method || "GET").toUpperCase() === "POST" && url.startsWith(urlPrefix);
    })
    .map(([, init]) => {
      const body = (init as RequestInit | undefined)?.body;
      return body ? (JSON.parse(String(body)) as Record<string, unknown>) : {};
    });
}

export function postUrls(fetchMock: ReturnType<typeof installFetchMock>, urlPrefix: string): string[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      const url = String(input);
      return String((init as RequestInit | undefined)?.method || "GET").toUpperCase() === "POST" && url.startsWith(urlPrefix);
    })
    .map(([input]) => String(input));
}

export { jsonResponse };
