import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "@/shared/stores/auth";
import { notifyAuthReset } from "@/shared/composables/useAbortScope";
import { useHistoryStore } from "../stores/history";
import type { GenerationHistoryItem, HistoryBrand } from "../api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const FIXTURE_GENERATIONS: GenerationHistoryItem[] = [
  {
    id: 101,
    type: "moments",
    cardTitle: "露营装备指南",
    brandName: "户外探索",
    brandId: 1,
    channelLabel: "朋友圈",
    createdAt: "2026-08-01T10:00:00.000Z",
    previewUrl: "/api/generated-images/101/file?assetExpires=1893456000000&sig=abc",
    payload: { caption: "周末露营装备", visualDirection: "自然质感" },
  },
  {
    id: 102,
    type: "videoScript",
    cardTitle: "露营冲煮咖啡视频脚本",
    brandName: "户外探索",
    brandId: 1,
    channelLabel: "视频脚本",
    createdAt: "2026-08-01T11:00:00.000Z",
    previewUrl: "",
    payload: {
      videoScript: {
        title: "露营冲煮咖啡视频脚本",
        creativeConcept: "在山野之间手冲一杯好咖啡",
        totalDurationSec: 30,
        aspectRatio: "9:16",
        globalSubjectReference: "手冲器具与咖啡豆",
        globalStyleReference: "清晨自然光电影感",
        globalContinuity: "动作连贯",
        audioDirection: { music: "自然风声与轻柔吉他", ambience: "水流声", voiceStyle: "沉静自然" },
        clips: [],
      },
    },
  },
];

const FIXTURE_BRANDS: HistoryBrand[] = [{ id: 1, name: "户外探索" }];

describe("HistoryStore", () => {
  let pinia: ReturnType<typeof createPinia>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/brands")) {
        return jsonResponse(200, { brands: FIXTURE_BRANDS });
      }
      if (url.startsWith("/api/history")) {
        return jsonResponse(200, { generations: FIXTURE_GENERATIONS });
      }
      throw new Error("Unhandled URL: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not fetch if user is not logged in", async () => {
    const auth = useAuthStore();
    auth.user = null;

    const store = useHistoryStore();
    const result = await store.ensureLoaded();

    expect(result).toEqual([]);
    expect(store.loaded).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads history and brands when user is logged in", async () => {
    const auth = useAuthStore();
    auth.user = { id: "user-1", name: "张三", phone: "13800000000" };

    const store = useHistoryStore();
    const result = await store.ensureLoaded();
    await store.loadBrands();

    expect(result).toHaveLength(2);
    expect(store.items).toHaveLength(2);
    expect(store.brands).toHaveLength(1);
    expect(store.loaded).toBe(true);
    expect(store.loading).toBe(false);
    expect(store.ownerUserId).toBe("user-1");
    expect(store.loadedAt).toBeGreaterThan(0);
    expect(store.freshUntil).toBeGreaterThan(Date.now());
  });

  it("deduplicates concurrent ensureLoaded calls to a single network round-trip", async () => {
    const auth = useAuthStore();
    auth.user = { id: "user-1", name: "张三", phone: "13800000000" };

    const store = useHistoryStore();
    const [p1, p2] = await Promise.all([store.ensureLoaded(), store.ensureLoaded()]);

    expect(p1).toHaveLength(2);
    expect(p2).toHaveLength(2);
    const historyCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/history"));
    expect(historyCalls).toHaveLength(1);
  });

  it("reuses cached items when store is loaded and fresh", async () => {
    const auth = useAuthStore();
    auth.user = { id: "user-1", name: "张三", phone: "13800000000" };

    const store = useHistoryStore();
    await store.ensureLoaded();
    const historyCallsFirst = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/history"));
    expect(historyCallsFirst).toHaveLength(1);

    await store.ensureLoaded();
    const historyCallsSecond = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/history"));
    expect(historyCallsSecond).toHaveLength(1);
  });

  it("forces reload on refresh()", async () => {
    const auth = useAuthStore();
    auth.user = { id: "user-1", name: "张三", phone: "13800000000" };

    const store = useHistoryStore();
    await store.ensureLoaded();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/history"))).toHaveLength(1);

    await store.refresh();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/history"))).toHaveLength(2);
  });

  it("clears cache and isolates data when account changes or auth is reset", async () => {
    const auth = useAuthStore();
    auth.user = { id: "user-1", name: "张三", phone: "13800000000" };

    const store = useHistoryStore();
    await store.ensureLoaded();
    expect(store.items).toHaveLength(2);

    // Switch account
    auth.user = { id: "user-2", name: "李四", phone: "13900000000" };
    await store.ensureLoaded();
    expect(store.ownerUserId).toBe("user-2");

    // Auth reset
    notifyAuthReset();
    expect(store.items).toHaveLength(0);
    expect(store.loaded).toBe(false);
  });

  it("supports upsertGeneration and removeGeneration locally", async () => {
    const auth = useAuthStore();
    auth.user = { id: "user-1", name: "张三", phone: "13800000000" };

    const store = useHistoryStore();
    await store.ensureLoaded();

    const newItem: GenerationHistoryItem = {
      id: 999,
      type: "videoScript",
      cardTitle: "新生成的视频脚本",
      channelLabel: "视频脚本",
      createdAt: new Date().toISOString(),
    };

    store.upsertGeneration(newItem);
    expect(store.items).toHaveLength(3);
    expect(store.items[0].id).toBe(999);

    // Update in place
    store.upsertGeneration({ ...newItem, cardTitle: "更新后的标题" });
    expect(store.items).toHaveLength(3);
    expect(store.items[0].cardTitle).toBe("更新后的标题");

    // Remove
    store.removeGeneration(999);
    expect(store.items).toHaveLength(2);
    expect(store.items.some((item) => item.id === 999)).toBe(false);
  });
});
