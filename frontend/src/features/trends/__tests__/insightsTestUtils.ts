// Trends / Ideas 测试共用的夹具与 fetch mock 工具（mock 全局 fetch，不 mock 业务模块）。
import { vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import type { InsightsBrand, TrendIdea, TrendItem } from "../model/types";

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function makeIdea(overrides: Partial<TrendIdea> = {}): TrendIdea {
  return {
    title: "通勤咖啡自由指南",
    summary: "从办公室场景讲清手冲的性价比",
    angle: "职场人省钱又讲究的一杯",
    brandFit: "结合品牌豆单与冲煮器具做场景种草",
    audience: "一线城市上班族",
    hook: "工位上的第一口秋天",
    tags: ["#咖啡日常"],
    contentAssets: {},
    ...overrides,
  };
}

export function makeTrend(id: number, overrides: Partial<TrendItem> = {}): TrendItem {
  return {
    id,
    stableKey: `sk-${id}`,
    rank: 1,
    title: "秋日第一杯咖啡",
    category: "生活方式",
    summary: "秋季限定风味讨论量上升",
    score: 88,
    tags: ["#秋天"],
    evidenceIds: ["ev-1"],
    evidence: [
      {
        provider: "pgy",
        id: "ev-1",
        title: "证据笔记：秋天的咖啡馆",
        url: "https://example.com/note/1",
        source: "小红书",
        host: "xiaohongshu.com",
        publishedAt: "2026-07-20",
        snippet: "",
        sourceType: "",
        platformType: "",
        trustLevel: "",
        retrievedAt: "",
      },
    ],
    reason: "与品牌人群和场景高度重合",
    ideas: [makeIdea(), makeIdea({ title: "秋日咖啡拍照攻略", hook: "拍出氛围感的三个角度" })],
    customPrompt: "",
    ...overrides,
  };
}

export function makeTrendItems(count: number, startId = 501): TrendItem[] {
  return Array.from({ length: count }, (_, index) =>
    makeTrend(startId + index, {
      title: `秋日第一杯咖啡 ${index + 1}`,
      score: 99 - index,
    }),
  );
}

export function makeBrandSummary(overrides: Partial<InsightsBrand> = {}): InsightsBrand {
  return {
    id: 7,
    ownerUserId: 1,
    name: "红磨坊咖啡",
    industry: "咖啡",
    audience: "都市白领",
    description: "精品咖啡品牌",
    profileType: "brand",
    contentPillars: [],
    personaStyle: "",
    materialCount: 0,
    logo: null,
    assetTags: ["咖啡", "内容运营"],
    trendCount: 0,
    analysisCount: 0,
    ...overrides,
  } as InsightsBrand;
}

export function makeBrandDetail(items: TrendItem[], overrides: Partial<InsightsBrand> = {}): InsightsBrand {
  return {
    ...makeBrandSummary(),
    knowledgeBase: "",
    trends: items.length
      ? [
          {
            key: "xhs",
            title: "小红书热点话题",
            description: "从小红书站内高讨论、高收藏、高互动内容里筛选可被品牌借势的话题方向。",
            items,
          },
        ]
      : [],
    analyses: [
      {
        id: 9001,
        name: "红磨坊咖啡 - 小红书热点话题",
        timestamp: "2026-07-20 10:00",
        trendSnapshot: [],
      },
    ],
    ...overrides,
  } as InsightsBrand;
}

export const XHS_CATEGORY_TREE = {
  items: [
    {
      label: "美食",
      value: "美食",
      children: [{ label: "咖啡", value: "美食/咖啡" }],
    },
  ],
};

export type FetchHandler = (url: string, init?: RequestInit) => Response | undefined;

/** 全局 fetch mock：按 URL/method 路由，未命中直接抛错以暴露多余请求。 */
export function installFetchMock(handler: FetchHandler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const response = handler(url, init);
    if (!response) {
      throw new Error(`unexpected fetch: ${init?.method || "GET"} ${url}`);
    }
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
}

export function callsTo(fetchMock: ReturnType<typeof vi.fn>, path: string, method = "POST") {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = String(input);
    return url.includes(path) && String((init as RequestInit | undefined)?.method || "GET") === method;
  }) as Array<[string, RequestInit | undefined]>;
}

/** 测试用最小路由表（正式路由表在 app/router.ts，测试不依赖它）。 */
export function makeTestRouter(): Router {
  const Stub = { template: "<div />" };
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "trends", component: Stub },
      { path: "/ideas", name: "ideas", component: Stub },
      { path: "/generation", name: "generation", component: Stub },
      { path: "/login", name: "login", component: Stub },
    ],
  });
}

/** 只冲刷微任务，不依赖真实定时器（配合 vi.useFakeTimers 使用）。 */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}
