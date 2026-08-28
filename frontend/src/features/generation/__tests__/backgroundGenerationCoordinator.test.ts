import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { notifyAuthReset } from "@/shared/composables/useAbortScope";
import { useAuthStore } from "@/shared/stores/auth";
import { useHistoryStore } from "@/features/history/stores/history";
import { useGenerationTasksStore } from "../stores/generationTasks";
import WorkspaceShell from "@/app/views/WorkspaceShell.vue";
import IdeasView from "@/features/ideas/views/IdeasView.vue";
import HistoryView from "@/features/history/views/HistoryView.vue";
import { clearIdeaCreativeSettings } from "../ideaCreativeSettings";

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
      {
        path: "/",
        component: WorkspaceShell,
        children: [
          { path: "", name: "home", component: { template: "<div>Home</div>" } },
          { path: "brands", name: "brands", component: { template: "<div>Brands</div>" } },
          { path: "personal", name: "personal", component: { template: "<div>Personal</div>" } },
          { path: "trends", name: "trends", component: { template: "<div>Trends</div>" } },
          { path: "ideas", name: "ideas", component: IdeasView },
          { path: "excellent", name: "excellent", component: { template: "<div>Excellent</div>" } },
          { path: "history", name: "history", component: HistoryView },
          { path: "billing", name: "billing", component: { template: "<div>Billing</div>" } },
        ],
      },
      { path: "/login", name: "login", component: { template: "<div>Login</div>" } },
    ],
  });
}

const BRAND_DETAIL = {
  id: 7,
  name: "测试品牌A",
  industry: "母婴",
  audience: "宝妈",
  description: "品牌描述",
  product: "婴儿车",
  goal: "提升销量",
  knowledgeBase: "资料库",
  logo: null,
  assetTags: [],
  trends: [
    {
      key: "global",
      title: "全网热点",
      description: "趋势维度",
      items: [
        {
          id: 501,
          stableKey: "t-501",
          rank: 1,
          title: "春季出游潮",
          category: "母婴",
          summary: "出游需求激增",
          score: 92,
          reason: "季节性爆发",
          ideas: [
            {
              title: "轻便折叠车种草指南",
              summary: "出行必备轻便婴儿车",
              angle: "轻便实用",
              brandFit: "完美契合",
              audience: "新手妈妈",
              hook: "1秒收车有多爽",
              tags: ["#出游"],
              contentAssets: {
                moments: {
                  title: "朋友圈种草图",
                  caption: "周末出游带上它，单手秒收超轻松！",
                  visualDirection: "公园草地阳光实拍",
                },
                wechatLongImage: {
                  title: "长图标题",
                  publishTitle: "带娃春游怎么选车？",
                  intro: "本篇从重量、收纳、避震三个维度深度测评。",
                  outline: ["重量对比", "收纳测试", "避震体验"],
                  visualDirection: "清新测评长图",
                },
                xhsCarousel: {
                  title: "组图标题",
                  publishTitle: "选对婴儿车省力一半！",
                  publishCaption: "整理了新手妈妈必看的4个避坑指南。",
                  slides: [0, 1, 2, 3].map((i) => ({
                    pageLabel: `第 ${i + 1} 张`,
                    title: `避坑指南 ${i + 1}`,
                    copy: `第 ${i + 1} 页详细文案说明`,
                    prompt: `第 ${i + 1} 页生图提示词`,
                    visualDirection: `第 ${i + 1} 页视觉方向`,
                  })),
                },
              },
            },
          ],
        },
      ],
    },
  ],
};

function createMockFetch(overrides: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method || "GET").toUpperCase();
    const key = `${method} ${url.split("?")[0]}`;

    if (overrides[key]) return overrides[key](init);

    if (key === "GET /api/brands") {
      return jsonResponse(200, { brands: [{ id: 7, name: "测试品牌A" }] });
    }
    if (key === "GET /api/brands/7") {
      return jsonResponse(200, { brand: BRAND_DETAIL });
    }
    if (key === "GET /api/product-images") {
      return jsonResponse(200, { images: [] });
    }
    if (key === "GET /api/history") {
      return jsonResponse(200, { generations: [] });
    }
    if (key === "GET /api/session") {
      return jsonResponse(200, { user: { id: "u1", credits: 50, phone: "13900000000" } });
    }
    if (key === "GET /api/recharge-plans") {
      return jsonResponse(200, { plans: [] });
    }
    if (key === "GET /api/image-jobs/active") {
      return jsonResponse(200, { jobs: [] });
    }

    if (method === "POST" && /\/ideas\/\d+\/image$/.test(key)) {
      return jsonResponse(202, { jobId: "job_m1", user: { id: "u1", credits: 49 } });
    }
    if (method === "POST" && /\/wechat-long-image$/.test(key)) {
      return jsonResponse(202, { wechatPack: { title: "长图标题", publishTitle: "带娃春游怎么选车？", intro: "本篇测评导语" }, jobId: "job_w1", user: { id: "u1", credits: 49 } });
    }
    if (method === "POST" && /\/xhs-carousel\/preview$/.test(key)) {
      return jsonResponse(200, {
        carouselPack: {
          title: "选对婴儿车省力一半！",
          publishTitle: "选对婴儿车省力一半！",
          publishCaption: "整理了新手妈妈必看的4个避坑指南。",
          aspectRatio: "3:4",
          carouselGroupId: "group_xhs_123",
          slides: [0, 1, 2, 3].map((i) => ({
            pageLabel: `第 ${i + 1} 张`,
            title: `避坑指南 ${i + 1}`,
            copy: `第 ${i + 1} 页详细文案说明`,
            prompt: `第 ${i + 1} 页生图提示词`,
            visualDirection: `第 ${i + 1} 页视觉方向`,
          })),
        },
        user: { id: "u1" },
      });
    }
    if (method === "POST" && /\/xhs-carousel\/slides\/(\d+)$/.test(key)) {
      const slideIndex = Number(key.match(/\/slides\/(\d+)$/)?.[1] || 0);
      return jsonResponse(202, { slideJob: { slideIndex, jobId: `job_slide_${slideIndex}` }, carouselGroupId: "group_xhs_123", creditEventId: 101, user: { id: "u1", credits: 49 - slideIndex } });
    }
    if (method === "POST" && /\/xhs-carousel\/complete$/.test(key)) {
      return jsonResponse(200, { generation: { id: 88 }, carouselGroupId: "group_xhs_123", user: { id: "u1" } });
    }

    if (url.startsWith("/api/image-jobs/")) {
      return jsonResponse(200, {
        status: "completed",
        imageConcept: {
          title: "已完成图片标题",
          imageUrl: "/api/generated-images/88/file?sig=ok",
        },
        generationId: 88,
      });
    }

    return jsonResponse(404, { error: "not found" });
  });
}

describe("Background Generation Coordinator & UX Contracts", () => {
  beforeEach(() => {
    clearIdeaCreativeSettings();
  });

  afterEach(() => {
    notifyAuthReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("1. 点击即占位：点击生图后立即在 coordinator 与历史生成页中创建占位卡，文案优先于图片展示", async () => {
    const fetchMock = createMockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 50 };
    auth.sessionLoaded = true;

    const router = makeRouter();
    await router.push({ name: "ideas" });
    await router.isReady();

    const tasksStore = useGenerationTasksStore();

    const wrapper = mount({ template: "<router-view />" }, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();

    // 点击一键朋友圈图
    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();

    expect(tasksStore.tasks.length).toBe(1);
    expect(tasksStore.tasks[0].type).toBe("moments");
    expect(tasksStore.tasks[0].copy?.caption).toBe("周末出游带上它，单手秒收超轻松！");
    expect(tasksStore.placeholdersForHistory.length).toBe(1);
    expect(tasksStore.placeholdersForHistory[0].cardTitle).toBeTruthy();

    await flushPromises();
    wrapper.unmount();
  });

  it("2. 关窗期间提交仍继续：点击生图后快速关闭弹窗，后台提交与轮询不中断并最终完成", async () => {
    let pollJobCalled = false;
    const fetchMock = createMockFetch({
      "GET /api/image-jobs/job_m1": () => {
        pollJobCalled = true;
        return jsonResponse(200, {
          status: "completed",
          imageConcept: {
            title: "后台完成标题",
            imageUrl: "/api/generated-images/77/file?sig=done",
          },
          generationId: 77,
        });
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 50 };
    auth.sessionLoaded = true;

    const router = makeRouter();
    await router.push({ name: "ideas" });
    await router.isReady();

    const tasksStore = useGenerationTasksStore();
    const wrapper = mount({ template: "<router-view />" }, { global: { plugins: [pinia, router] } });
    await flushPromises();

    // 打开生图弹窗
    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(true);

    // 立即点击关闭弹窗
    await wrapper.find('[data-test="idea-generation-close"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="idea-generation-dialog"]').exists()).toBe(false);

    // 后台任务仍然在运行并完成
    await flushPromises();
    await flushPromises();
    expect(pollJobCalled).toBe(true);
    expect(tasksStore.tasks[0].status).toBe("completed");
    expect(tasksStore.tasks[0].imageUrl).toBe("/api/generated-images/77/file?sig=done");

    wrapper.unmount();
  });

  it("3. 小红书单张转四张不重复提交：单张生成中点击一键四张，只补交剩余三张，已在生成的页面不重复请求", async () => {
    const slideRequests: number[] = [];
    const fetchMock = createMockFetch({
      "POST /api/brands/7/trends/501/ideas/0/xhs-carousel/slides/0": () => {
        slideRequests.push(0);
        return jsonResponse(202, { slideJob: { slideIndex: 0, jobId: "s0" }, carouselGroupId: "group_xhs_123", creditEventId: 10 });
      },
      "POST /api/brands/7/trends/501/ideas/0/xhs-carousel/slides/1": () => {
        slideRequests.push(1);
        return jsonResponse(202, { slideJob: { slideIndex: 1, jobId: "s1" }, carouselGroupId: "group_xhs_123", creditEventId: 11 });
      },
      "POST /api/brands/7/trends/501/ideas/0/xhs-carousel/slides/2": () => {
        slideRequests.push(2);
        return jsonResponse(202, { slideJob: { slideIndex: 2, jobId: "s2" }, carouselGroupId: "group_xhs_123", creditEventId: 12 });
      },
      "POST /api/brands/7/trends/501/ideas/0/xhs-carousel/slides/3": () => {
        slideRequests.push(3);
        return jsonResponse(202, { slideJob: { slideIndex: 3, jobId: "s3" }, carouselGroupId: "group_xhs_123", creditEventId: 13 });
      },
      "GET /api/image-jobs/s0": () => jsonResponse(200, { status: "pending" }),
      "GET /api/image-jobs/s1": () => jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/img1.png" } }),
      "GET /api/image-jobs/s2": () => jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/img2.png" } }),
      "GET /api/image-jobs/s3": () => jsonResponse(200, { status: "completed", imageConcept: { imageUrl: "/img3.png" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 50 };
    auth.sessionLoaded = true;

    const router = makeRouter();
    await router.push({ name: "ideas" });
    await router.isReady();

    const wrapper = mount({ template: "<router-view />" }, { global: { plugins: [pinia, router] } });
    await flushPromises();

    // 打开小红书组图
    await wrapper.find('[data-test="idea-generate-xhs-0"]').trigger("click");
    await flushPromises();

    // 1) 先点击生成第 1 张（slide 0）
    await wrapper.find('[data-test="generate-xhs-slide-0"]').trigger("click");
    await flushPromises();
    expect(slideRequests).toEqual([0]);

    // 2) 此时点击一键生成全部四张
    await wrapper.find('[data-test="generate-xhs-all"]').trigger("click");
    await flushPromises();

    // 验证：slide 0 未被重复提交，只提交了 1, 2, 3
    expect(slideRequests).toEqual([0, 1, 2, 3]);

    wrapper.unmount();
  });

  it("4. 侧栏状态同步与点击历史清除完成状态：进行中显示加载器，全部完成显示已完成，点击历史生成清除已完成", async () => {
    const fetchMock = createMockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 50 };
    auth.sessionLoaded = true;

    const router = makeRouter();
    await router.push({ name: "ideas" });
    await router.isReady();

    const tasksStore = useGenerationTasksStore();
    const wrapper = mount({ template: "<router-view />" }, { global: { plugins: [pinia, router] } });
    await flushPromises();

    // 初始：无进行中无完成
    expect(wrapper.find('[data-test="sidebar-task-running"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="sidebar-task-completed"]').exists()).toBe(false);

    // 启动生图任务
    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();

    // 等待生图任务完成
    await flushPromises();
    await flushPromises();
    expect(tasksStore.hasRunningTasks).toBe(false);
    expect(tasksStore.hasUnviewedSuccess).toBe(true);
    // 全部结束且未查看：显示“已完成”
    expect(wrapper.find('[data-test="sidebar-task-completed"]').exists()).toBe(true);

    // 导航到“历史生成”页
    await router.push({ name: "history" });
    await flushPromises();

    // “已完成”状态被清除
    expect(tasksStore.hasUnviewedSuccess).toBe(false);
    expect(wrapper.find('[data-test="sidebar-task-completed"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("5. 失败不误报：生图失败显示错误状态，侧栏绝不误报“已完成”", async () => {
    const fetchMock = createMockFetch({
      "GET /api/image-jobs/job_m1": () => {
        return jsonResponse(200, {
          status: "failed",
          error: "图片供应商超时",
        });
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 50 };
    auth.sessionLoaded = true;

    const router = makeRouter();
    await router.push({ name: "ideas" });
    await router.isReady();

    const tasksStore = useGenerationTasksStore();
    const wrapper = mount({ template: "<router-view />" }, { global: { plugins: [pinia, router] } });
    await flushPromises();

    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
    await flushPromises();

    expect(tasksStore.tasks[0].status).toBe("failed");
    expect(tasksStore.hasUnviewedSuccess).toBe(false);
    expect(tasksStore.hasUnresolvedFailures).toBe(true);
    expect(wrapper.find('[data-test="sidebar-task-completed"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="sidebar-task-failed"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("6. 账号切换隔离：notifyAuthReset 中止全部后台轮询并清空任务状态", async () => {
    const fetchMock = createMockFetch({
      "GET /api/image-jobs/job_m1": () => jsonResponse(200, { status: "pending" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 50 };
    auth.sessionLoaded = true;

    const router = makeRouter();
    await router.push({ name: "ideas" });
    await router.isReady();

    const tasksStore = useGenerationTasksStore();
    const wrapper = mount({ template: "<router-view />" }, { global: { plugins: [pinia, router] } });
    await flushPromises();

    await wrapper.find('[data-test="idea-generate-moments-0"]').trigger("click");
    await flushPromises();
    expect(tasksStore.tasks.length).toBe(1);
    expect(tasksStore.controllers.size).toBe(1);

    // 模拟账号登出/重置
    notifyAuthReset();
    expect(tasksStore.tasks.length).toBe(0);
    expect(tasksStore.controllers.size).toBe(0);

    wrapper.unmount();
  });

  it("7. 历史骨架与无闪烁替换：历史页先显示骨架与文案，出图完成后用正式记录替换占位", async () => {
    const fetchMock = createMockFetch();
    vi.stubGlobal("fetch", fetchMock);

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 50 };
    auth.sessionLoaded = true;

    const router = makeRouter();
    await router.push({ name: "history" });
    await router.isReady();

    const tasksStore = useGenerationTasksStore();
    const historyStore = useHistoryStore();

    // 模拟一个刚创建的占位任务（文案已就绪，图片生成中）
    tasksStore.tasks.push({
      id: "test_task_ph",
      type: "moments",
      channelLabel: "朋友圈图",
      brandId: 7,
      trendId: 501,
      ideaIndex: 0,
      brandName: "测试品牌A",
      trendTitle: "全网热点",
      ideaTitle: "轻便折叠车种草指南",
      cardTitle: "轻便折叠车种草指南",
      status: "polling",
      createdAt: Date.now(),
      viewed: false,
      copy: {
        caption: "周末出游带上它，单手秒收超轻松！",
        visualDirection: "公园草地阳光实拍",
      },
    });

    const wrapper = mount(HistoryView, { global: { plugins: [pinia, router] } });
    await flushPromises();

    // 占位卡显示文案与生成中图片占位
    expect(wrapper.find('[data-test="history-placeholder-tag"]').text()).toContain("生图中");
    expect(wrapper.text()).toContain("周末出游带上它，单手秒收超轻松！");
    expect(wrapper.find('[data-test="history-placeholder-image"]').exists()).toBe(true);

    // 模拟正式记录到达
    historyStore.items = [
      {
        id: 999,
        ownerUserId: 1,
        type: "moments",
        channelLabel: "朋友圈图",
        brandId: 7,
        brandName: "测试品牌A",
        trendId: 501,
        trendTitle: "全网热点",
        ideaTitle: "轻便折叠车种草指南",
        cardTitle: "轻便折叠车种草指南",
        createdAt: new Date().toISOString(),
        previewUrl: "/api/generated-images/999/file?sig=done",
        summary: "周末出游带上它",
        payload: { caption: "周末出游带上它，单手秒收超轻松！" },
      },
    ];
    tasksStore.tasks[0].status = "completed";
    tasksStore.tasks[0].generationId = 999;
    await flushPromises();

    // 占位卡被正式历史记录无缝替换（仅展示 1 张卡，不重复）
    expect(wrapper.findAll('[data-test="history-card"]').length).toBe(1);
    expect(wrapper.find('[data-test="history-placeholder-tag"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("8. 视频脚本生成：启动视频脚本生成后，左侧栏历史生成显示旋转加载器，完成后更新侧栏并展示结果", async () => {
    const fetchMock = createMockFetch({
      "POST /api/brands/7/trends/501/ideas/0/video-script": () => {
        return jsonResponse(200, {
          videoScript: {
            title: "生成好的视频脚本",
            creativeConcept: "脚本核心创意",
            totalDurationSec: 15,
            clips: [{ index: 1, durationSec: 15, purpose: "演示", prompt: "镜头提示词" }],
          },
          generation: { id: 333, cardTitle: "生成好的视频脚本", summary: "脚本摘要" },
          user: { id: "u1", credits: 49 },
        });
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const pinia = createPinia();
    setActivePinia(pinia);
    const auth = useAuthStore();
    auth.user = { id: "1", name: "测试用户", credits: 50 };
    auth.sessionLoaded = true;

    const router = makeRouter();
    await router.push({ name: "ideas" });
    await router.isReady();

    const tasksStore = useGenerationTasksStore();
    const wrapper = mount({ template: "<router-view />" }, { global: { plugins: [pinia, router] } });
    await flushPromises();

    // 点击一键生成脚本
    await wrapper.find('[data-test="idea-generate-script-0"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-test="video-script-generate"]').trigger("click");
    await flushPromises();

    // 验证：视频脚本任务已注册进 tasksStore，并在侧栏历史生成旁触发旋转动画
    expect(tasksStore.tasks.length).toBe(1);
    expect(tasksStore.tasks[0].type).toBe("videoScript");
    expect(tasksStore.tasks[0].status).toBe("completed");
    expect(tasksStore.tasks[0].cardTitle).toBe("生成好的视频脚本");
    expect(tasksStore.hasUnviewedSuccess).toBe(true);
    expect(wrapper.find('[data-test="sidebar-task-completed"]').exists()).toBe(true);

    wrapper.unmount();
  });
});
