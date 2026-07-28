/**
 * 任务1：品牌/个人 IP CUD 成功后趋势、选题使用的品牌缓存必须失效。
 * BrandsView / PersonalIpView 的保存与删除成功回调调用
 * notifyBrandDataChanged(brandId)（见 BrandsView.vue / PersonalIpView.vue），
 * insights store 据版本快照丢弃旧详情，重新进入趋势页时重新
 * GET /api/brands/:id，不得残留旧 knowledgeBase / 名称 / Logo / 人设资料。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { notifyBrandDataChanged, resetBrandDataVersions } from "@/shared/stores/brandDataVersion";
import { useInsightsStore } from "../stores/insights";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

interface BrandFixture {
  id: number;
  name: string;
  industry: string;
  audience: string;
  description: string;
  profileType: string;
  knowledgeBase: string;
  logo: { originalName: string; url: string } | null;
  personaStyle: string;
  trends: unknown[];
  analyses: unknown[];
}

function makeBrand(overrides: Partial<BrandFixture> = {}): BrandFixture {
  return {
    id: 1,
    name: "山茶护肤",
    industry: "护肤",
    audience: "25-35 女性",
    description: "山茶花油护肤品牌",
    profileType: "brand",
    knowledgeBase: "旧版品牌知识库：主打山茶花油。",
    logo: { originalName: "old-logo.png", url: "/api/brands/1/logo/file?sig=old" },
    personaStyle: "",
    trends: [],
    analyses: [],
    ...overrides,
  };
}

describe("insights store brand cache invalidation", () => {
  let detailFixture: BrandFixture;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActivePinia(createPinia());
    resetBrandDataVersions();
    detailFixture = makeBrand();
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/brands?summary=1") {
        const { trends: _t, analyses: _a, knowledgeBase: _k, ...summary } = detailFixture;
        return jsonResponse({ brands: [summary] });
      }
      if (url === "/api/brands/1") return jsonResponse({ brand: detailFixture });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetBrandDataVersions();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function detailRequestCount(): number {
    return fetchMock.mock.calls.filter(([input]) => String(input) === "/api/brands/1").length;
  }

  it("re-fetches GET /api/brands/:id after a brand edit and exposes the new knowledgeBase and name", async () => {
    const store = useInsightsStore();

    // 首次进入趋势页：摘要 + 详情各拉一次，之后命中缓存不再请求。
    await store.loadBrands();
    await store.ensureBrandDetail(1);
    expect(detailRequestCount()).toBe(1);
    const cached = await store.ensureBrandDetail(1);
    expect(detailRequestCount()).toBe(1);
    expect(cached?.knowledgeBase).toBe("旧版品牌知识库：主打山茶花油。");

    // 品牌编辑保存成功（BrandsView handleSaved 的真实失效路径）。
    detailFixture = makeBrand({
      name: "山茶护肤·焕新",
      knowledgeBase: "新版品牌知识库：新增精华产品线。",
      logo: { originalName: "new-logo.png", url: "/api/brands/1/logo/file?sig=new" },
    });
    notifyBrandDataChanged(1);

    // 重新进入趋势页（TrendsView onMounted 的加载路径）：必须重新 GET 详情。
    await store.loadBrands();
    const refreshed = await store.ensureBrandDetail(1);
    expect(detailRequestCount()).toBe(2);
    expect(refreshed?.name).toBe("山茶护肤·焕新");
    expect(refreshed?.knowledgeBase).toBe("新版品牌知识库：新增精华产品线。");
    expect(refreshed?.logo?.url).toContain("sig=new");
    expect(store.selectedBrand?.knowledgeBase).toBe("新版品牌知识库：新增精华产品线。");
  });

  it("a global invalidation (create/delete without id) also drops cached details", async () => {
    const store = useInsightsStore();
    await store.loadBrands();
    await store.ensureBrandDetail(1);
    expect(detailRequestCount()).toBe(1);

    // 新建/删除档案时 brand id 可能未知：无参失效使所有品牌缓存过期。
    detailFixture = makeBrand({ knowledgeBase: "删除重建后的知识库。" });
    notifyBrandDataChanged();

    await store.loadBrands();
    const refreshed = await store.ensureBrandDetail(1);
    expect(detailRequestCount()).toBe(2);
    expect(refreshed?.knowledgeBase).toBe("删除重建后的知识库。");
  });
});
