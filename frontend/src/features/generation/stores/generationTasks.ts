import { defineStore } from "pinia";
import { reactive } from "vue";
import { onAuthReset } from "@/shared/composables/useAbortScope";
import { useAuthStore } from "@/shared/stores/auth";
import { useHistoryStore } from "@/features/history/stores/history";
import { isAbortError } from "@/shared/api/client";
import {
  completeXhsCarousel,
  fetchActiveImageJobs,
  pollImageJob,
  previewXhsCarousel,
  submitMomentsImage,
  submitStyleImage,
  submitWechatLongImage,
  submitXhsCarouselSlide,
  type BrandDetail,
  type CarouselPack,
  type CarouselSlide,
  type IdeaDetail,
  type ProductImageInput,
  type RecoverableImageJob,
  type TrendDetail,
} from "../api";

export type GenerationTaskType = "moments" | "wechat" | "xhsCarousel" | "styleImage";
export type GenerationTaskStatus = "idle" | "submitting" | "polling" | "completed" | "failed";

export interface CarouselSlideItem {
  index: number;
  pageLabel: string;
  title: string;
  copy: string;
  prompt: string;
  visualDirection?: string;
  style?: string;
  composition?: string;
  status: "idle" | "submitting" | "polling" | "completed" | "failed";
  jobId?: string;
  imageUrl?: string;
  previewUrl?: string;
  error?: string;
  isEditing?: boolean;
  editPrompt?: string;
}

export interface GenerationTaskItem {
  id: string; // client task ID
  jobId?: string; // image job id for single-image jobs
  type: GenerationTaskType;
  channelLabel: string;
  brandId: number | null;
  trendId: number | null;
  ideaIndex: number | null;
  brandName: string;
  trendTitle: string;
  ideaTitle: string;
  cardTitle: string;
  aspectRatio?: string;
  status: GenerationTaskStatus;
  createdAt: number;
  completedAt?: number;
  completing?: boolean;
  imageUrl?: string;
  previewUrl?: string;
  error?: string;
  generationId?: number | null;
  creditEventId?: number | null;
  viewed: boolean;
  copy?: {
    caption?: string;
    visualDirection?: string;
    publishTitle?: string;
    intro?: string;
    publishCaption?: string;
    outline?: string[];
  };
  carouselGroupId?: string;
  carouselPack?: CarouselPack | null;
  slides?: CarouselSlideItem[];
}

function channelLabelForType(type: GenerationTaskType): string {
  switch (type) {
    case "moments":
      return "朋友圈图";
    case "wechat":
      return "公众号长图";
    case "xhsCarousel":
      return "小红书组图";
    case "styleImage":
      return "风格化图";
    default:
      return "图片生成";
  }
}

export const useGenerationTasksStore = defineStore("generationTasks", {
  state: () => ({
    tasks: [] as GenerationTaskItem[],
    controllers: new Map<string, AbortController>(),
    syncing: false,
    syncGeneration: 0,
  }),

  getters: {
    activeTasks: (state) =>
      state.tasks.filter((task) => task.status === "submitting" || task.status === "polling"),

    hasRunningTasks: (state) =>
      state.tasks.some(
        (task) =>
          task.status === "submitting" ||
          task.status === "polling" ||
          (task.type === "xhsCarousel" &&
            task.slides?.some((s) => s.status === "submitting" || s.status === "polling")),
      ),

    runningTasksCount: (state) =>
      state.tasks.filter(
        (task) =>
          task.status === "submitting" ||
          task.status === "polling" ||
          (task.type === "xhsCarousel" &&
            task.slides?.some((s) => s.status === "submitting" || s.status === "polling")),
      ).length,

    hasUnresolvedFailures: (state) =>
      state.tasks.some(
        (task) =>
          !task.viewed &&
          (task.status === "failed" ||
            (task.type === "xhsCarousel" &&
              task.slides?.some((s) => s.status === "failed") &&
              !task.slides?.every((s) => s.status === "completed"))),
      ),

    hasUnviewedSuccess(): boolean {
      if (this.hasRunningTasks || this.hasUnresolvedFailures) return false;
      return this.tasks.some(
        (task) =>
          !task.viewed &&
          (task.status === "completed" ||
            (task.type === "xhsCarousel" &&
              task.slides?.length === 4 &&
              task.slides.every((s) => s.status === "completed"))),
      );
    },

    placeholdersForHistory: (state) => {
      const historyStore = useHistoryStore();
      const existingHistoryIds = new Set(historyStore.items.map((item) => Number(item.id)));
      const existingGroupIds = new Set(
        historyStore.items
          .map((item) => String(item.payload?.carouselGroupId || "").trim())
          .filter(Boolean),
      );

      return state.tasks.filter((task) => {
        if (task.status === "submitting" || task.status === "polling") {
          return true;
        }
        if (task.status === "completed") {
          if (task.generationId && existingHistoryIds.has(Number(task.generationId))) {
            return false;
          }
          if (task.carouselGroupId && existingGroupIds.has(task.carouselGroupId)) {
            return false;
          }
          return true;
        }
        return false;
      });
    },
  },

  actions: {
    findTask(type: GenerationTaskType, brandId: number, trendId: number, ideaIndex: number): GenerationTaskItem | undefined {
      return this.tasks.find(
        (t) =>
          t.type === type &&
          Number(t.brandId) === Number(brandId) &&
          Number(t.trendId) === Number(trendId) &&
          Number(t.ideaIndex) === Number(ideaIndex),
      );
    },

    findTaskById(id: string): GenerationTaskItem | undefined {
      return this.tasks.find((t) => t.id === id || t.jobId === id || t.carouselGroupId === id);
    },

    markAllViewed(): void {
      for (const task of this.tasks) {
        task.viewed = true;
      }
    },

    async startMomentsTask(params: {
      brand: BrandDetail;
      trend: TrendDetail;
      idea: IdeaDetail;
      ideaIndex: number;
      aspectRatio: string;
      productImages: ProductImageInput[];
      useBrandLogo: boolean;
    }): Promise<GenerationTaskItem> {
      const auth = useAuthStore();
      const historyStore = useHistoryStore();
      const clientTaskId = `moments_${params.brand.id}_${params.trend.id}_${params.ideaIndex}_${Date.now()}`;

      const existingIndex = this.tasks.findIndex(
        (t) =>
          t.type === "moments" &&
          Number(t.brandId) === Number(params.brand.id) &&
          Number(t.trendId) === Number(params.trend.id) &&
          Number(t.ideaIndex) === Number(params.ideaIndex),
      );
      if (existingIndex >= 0) {
        this.tasks.splice(existingIndex, 1);
      }

      const contentAssets = params.idea.contentAssets as Record<string, any> | undefined;
      const momentsAsset = contentAssets?.moments;

      const task: GenerationTaskItem = reactive({
        id: clientTaskId,
        type: "moments",
        channelLabel: "朋友圈图",
        brandId: params.brand.id,
        trendId: params.trend.id,
        ideaIndex: params.ideaIndex,
        brandName: params.brand.name || "",
        trendTitle: params.trend.title || "",
        ideaTitle: params.idea.title || "",
        cardTitle: params.idea.title || "朋友圈图",
        aspectRatio: params.aspectRatio,
        status: "submitting",
        createdAt: Date.now(),
        viewed: false,
        copy: {
          caption: typeof momentsAsset?.caption === "string" ? momentsAsset.caption : "",
          visualDirection: typeof momentsAsset?.visualDirection === "string" ? momentsAsset.visualDirection : "",
        },
      });

      this.tasks.unshift(task);

      const controller = new AbortController();
      this.controllers.set(clientTaskId, controller);

      try {
        const submitResult = await submitMomentsImage(
          params.brand.id,
          params.trend.id,
          params.ideaIndex,
          {
            productImages: params.productImages,
            useBrandLogo: params.useBrandLogo,
            aspectRatio: params.aspectRatio,
          },
          controller.signal,
        );
        if (submitResult.user) auth.user = submitResult.user;
        if (!submitResult.jobId) throw new Error("图片任务创建失败");

        task.jobId = submitResult.jobId;
        task.status = "polling";

        const concept = await pollImageJob(submitResult.jobId, {
          signal: controller.signal,
          onUser: (u) => {
            if (u) auth.user = u;
          },
        });

        task.imageUrl = concept.imageUrl || concept.previewUrl;
        task.previewUrl = concept.imageUrl || concept.previewUrl;
        if (concept.generationId) task.generationId = Number(concept.generationId);
        if (typeof concept.title === "string") task.cardTitle = concept.title;
        if (concept.caption || concept.visualDirection) {
          task.copy = {
            caption: typeof concept.caption === "string" ? concept.caption : task.copy?.caption,
            visualDirection: typeof concept.visualDirection === "string" ? concept.visualDirection : task.copy?.visualDirection,
          };
        }
        task.status = "completed";
        task.completedAt = Date.now();

        await auth.refreshUser().catch(() => {});
        await historyStore.refresh().catch(() => {});
        return task;
      } catch (error) {
        console.error('[generationTasks:startMomentsTask:error]', error);
        if (isAbortError(error) || controller.signal.aborted) return task;
        task.status = "failed";
        task.error = (error as Error).message || "图片生成失败";
        await auth.refreshUser().catch(() => {});
        throw error;
      } finally {
        this.controllers.delete(clientTaskId);
      }
    },

    async startWechatTask(params: {
      brand: BrandDetail;
      trend: TrendDetail;
      idea: IdeaDetail;
      ideaIndex: number;
      aspectRatio: string;
      productImages: ProductImageInput[];
      useBrandLogo: boolean;
      wechatTemplate: string;
    }): Promise<GenerationTaskItem> {
      const auth = useAuthStore();
      const historyStore = useHistoryStore();
      const clientTaskId = `wechat_${params.brand.id}_${params.trend.id}_${params.ideaIndex}_${Date.now()}`;

      const existingIndex = this.tasks.findIndex(
        (t) =>
          t.type === "wechat" &&
          Number(t.brandId) === Number(params.brand.id) &&
          Number(t.trendId) === Number(params.trend.id) &&
          Number(t.ideaIndex) === Number(params.ideaIndex),
      );
      if (existingIndex >= 0) {
        this.tasks.splice(existingIndex, 1);
      }

      const contentAssets = params.idea.contentAssets as Record<string, any> | undefined;
      const wechatAsset = contentAssets?.wechatLongImage;

      const task: GenerationTaskItem = reactive({
        id: clientTaskId,
        type: "wechat",
        channelLabel: "公众号长图",
        brandId: params.brand.id,
        trendId: params.trend.id,
        ideaIndex: params.ideaIndex,
        brandName: params.brand.name || "",
        trendTitle: params.trend.title || "",
        ideaTitle: params.idea.title || "",
        cardTitle: params.idea.title || "公众号长图",
        aspectRatio: params.aspectRatio,
        status: "submitting",
        createdAt: Date.now(),
        viewed: false,
        copy: {
          publishTitle: typeof wechatAsset?.publishTitle === "string" ? wechatAsset.publishTitle : params.idea.title,
          intro: typeof wechatAsset?.intro === "string" ? wechatAsset.intro : "",
          visualDirection: typeof wechatAsset?.visualDirection === "string" ? wechatAsset.visualDirection : "",
          outline: Array.isArray(wechatAsset?.outline) ? wechatAsset.outline : [],
        },
      });

      this.tasks.unshift(task);

      const controller = new AbortController();
      this.controllers.set(clientTaskId, controller);

      try {
        const submitResult = await submitWechatLongImage(
          params.brand.id,
          params.trend.id,
          params.ideaIndex,
          {
            productImages: params.productImages,
            useBrandLogo: params.useBrandLogo,
            wechatTemplate: params.wechatTemplate,
            aspectRatio: params.aspectRatio,
          },
          controller.signal,
        );
        if (submitResult.user) auth.user = submitResult.user;
        if (!submitResult.jobId) throw new Error("公众号长图任务创建失败");

        task.jobId = submitResult.jobId;
        task.status = "polling";

        if (submitResult.wechatPack) {
          task.copy = {
            publishTitle: submitResult.wechatPack.publishTitle || task.copy?.publishTitle,
            intro: submitResult.wechatPack.intro || task.copy?.intro,
            visualDirection: typeof submitResult.wechatPack.visualDirection === "string" ? submitResult.wechatPack.visualDirection : task.copy?.visualDirection,
            outline: submitResult.wechatPack.outline || task.copy?.outline,
          };
        }

        const concept = await pollImageJob(submitResult.jobId, {
          signal: controller.signal,
          onUser: (u) => {
            if (u) auth.user = u;
          },
        });

        task.imageUrl = concept.imageUrl || concept.previewUrl;
        task.previewUrl = concept.imageUrl || concept.previewUrl;
        if (concept.generationId) task.generationId = Number(concept.generationId);
        task.status = "completed";
        task.completedAt = Date.now();

        await auth.refreshUser().catch(() => {});
        await historyStore.refresh().catch(() => {});
        return task;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return task;
        task.status = "failed";
        task.error = (error as Error).message || "图片生成失败";
        await auth.refreshUser().catch(() => {});
        throw error;
      } finally {
        this.controllers.delete(clientTaskId);
      }
    },

    async startStyleImageTask(params: {
      brand: BrandDetail;
      trend: TrendDetail;
      idea: IdeaDetail;
      ideaIndex: number;
      aspectRatio: string;
      stylePrompt: string;
      useBrandLogo: boolean;
      styleReferenceImages: Array<{ name?: string; dataUrl?: string }>;
    }): Promise<GenerationTaskItem> {
      const auth = useAuthStore();
      const historyStore = useHistoryStore();
      const clientTaskId = `style_${params.brand.id}_${params.trend.id}_${params.ideaIndex}_${Date.now()}`;

      const existingIndex = this.tasks.findIndex(
        (t) =>
          t.type === "styleImage" &&
          Number(t.brandId) === Number(params.brand.id) &&
          Number(t.trendId) === Number(params.trend.id) &&
          Number(t.ideaIndex) === Number(params.ideaIndex),
      );
      if (existingIndex >= 0) {
        this.tasks.splice(existingIndex, 1);
      }

      const task: GenerationTaskItem = reactive({
        id: clientTaskId,
        type: "styleImage",
        channelLabel: "风格化图",
        brandId: params.brand.id,
        trendId: params.trend.id,
        ideaIndex: params.ideaIndex,
        brandName: params.brand.name || "",
        trendTitle: params.trend.title || "",
        ideaTitle: params.idea.title || "",
        cardTitle: params.idea.title || "风格化图",
        aspectRatio: params.aspectRatio,
        status: "submitting",
        createdAt: Date.now(),
        viewed: false,
        copy: {
          visualDirection: params.stylePrompt,
        },
      });

      this.tasks.unshift(task);

      const controller = new AbortController();
      this.controllers.set(clientTaskId, controller);

      try {
        const submitResult = await submitStyleImage(
          params.brand.id,
          params.trend.id,
          params.ideaIndex,
          {
            title: params.idea.title || "风格化图片",
            stylePrompt: params.stylePrompt,
            useBrandLogo: params.useBrandLogo,
            aspectRatio: params.aspectRatio,
            styleReferenceImages: params.styleReferenceImages,
          },
          controller.signal,
        );
        if (submitResult.user) auth.user = submitResult.user;
        if (!submitResult.jobId) throw new Error("风格化图任务创建失败");

        task.jobId = submitResult.jobId;
        task.status = "polling";

        const concept = await pollImageJob(submitResult.jobId, {
          signal: controller.signal,
          onUser: (u) => {
            if (u) auth.user = u;
          },
        });

        task.imageUrl = concept.imageUrl || concept.previewUrl;
        task.previewUrl = concept.imageUrl || concept.previewUrl;
        if (concept.generationId) task.generationId = Number(concept.generationId);
        task.status = "completed";
        task.completedAt = Date.now();

        await auth.refreshUser().catch(() => {});
        await historyStore.refresh().catch(() => {});
        return task;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return task;
        task.status = "failed";
        task.error = (error as Error).message || "图片生成失败";
        await auth.refreshUser().catch(() => {});
        throw error;
      } finally {
        this.controllers.delete(clientTaskId);
      }
    },

    async prepareXhsCarouselTask(params: {
      brand: BrandDetail;
      trend: TrendDetail;
      idea: IdeaDetail;
      ideaIndex: number;
      aspectRatio: string;
      visualStylePreset: string;
      signal?: AbortSignal;
    }): Promise<GenerationTaskItem> {
      const auth = useAuthStore();
      const previewResult = await previewXhsCarousel(
        params.brand.id,
        params.trend.id,
        params.ideaIndex,
        { aspectRatio: params.aspectRatio, visualStylePreset: params.visualStylePreset },
        params.signal,
      );
      if (previewResult.user) auth.user = previewResult.user;
      const pack = previewResult.carouselPack;
      if (!pack || !Array.isArray(pack.slides)) {
        throw new Error("AI 没有返回可用的小红书组图方案，请稍后重试。");
      }

      const groupId = String(pack.carouselGroupId || `group_${params.brand.id}_${params.trend.id}_${params.ideaIndex}_${Date.now()}`);
      const clientTaskId = `xhs_${groupId}`;

      let task = this.tasks.find(
        (t) =>
          t.type === "xhsCarousel" &&
          Number(t.brandId) === Number(params.brand.id) &&
          Number(t.trendId) === Number(params.trend.id) &&
          Number(t.ideaIndex) === Number(params.ideaIndex),
      );

      const slides: CarouselSlideItem[] = pack.slides.map((s, idx) => ({
        index: idx,
        pageLabel: String(s.pageLabel || `第 ${idx + 1} 张`),
        title: String(s.title || ""),
        copy: String(s.copy || ""),
        prompt: String(s.prompt || ""),
        visualDirection: typeof s.visualDirection === "string" ? s.visualDirection : "",
        style: typeof s.style === "string" ? s.style : "",
        composition: typeof s.composition === "string" ? s.composition : "",
        status: "idle",
      }));

      if (!task) {
        const createdTask: GenerationTaskItem = reactive({
          id: clientTaskId,
          type: "xhsCarousel",
          channelLabel: "小红书组图",
          brandId: params.brand.id,
          trendId: params.trend.id,
          ideaIndex: params.ideaIndex,
          brandName: params.brand.name || "",
          trendTitle: params.trend.title || "",
          ideaTitle: params.idea.title || "",
          cardTitle: String(pack.title || params.idea.title || "小红书组图"),
          aspectRatio: params.aspectRatio,
          status: "idle",
          createdAt: Date.now(),
          viewed: false,
          carouselGroupId: groupId,
          carouselPack: pack,
          slides,
          copy: {
            publishTitle: String(pack.publishTitle || pack.title || ""),
            publishCaption: String(pack.publishCaption || ""),
            caption: String(pack.caption || ""),
          },
        });
        this.tasks.unshift(createdTask);
        return createdTask;
      } else {
        task.carouselGroupId = groupId;
        task.carouselPack = pack;
        task.cardTitle = String(pack.title || task.cardTitle);
        task.copy = {
          publishTitle: String(pack.publishTitle || pack.title || ""),
          publishCaption: String(pack.publishCaption || ""),
          caption: String(pack.caption || ""),
        };
        if (!task.slides || task.slides.length === 0) {
          task.slides = slides;
        } else {
          for (let i = 0; i < slides.length; i++) {
            if (task.slides[i]?.status === "completed" && task.slides[i]?.imageUrl) {
              slides[i] = { ...task.slides[i] };
            }
          }
          task.slides = slides;
        }
        return task;
      }
    },

    async generateCarouselSlide(
      taskId: string,
      slideIndex: number,
      options: {
        productImages: ProductImageInput[];
        useBrandLogo: boolean;
        visualStylePreset: string;
      },
    ): Promise<void> {
      const auth = useAuthStore();
      const historyStore = useHistoryStore();
      const task = this.findTaskById(taskId);
      if (!task || !task.slides || !task.carouselPack || task.brandId == null || task.trendId == null || task.ideaIndex == null) {
        return;
      }

      const slide = task.slides[slideIndex];
      if (!slide) return;
      if (slide.status === "submitting" || slide.status === "polling" || (slide.status === "completed" && Boolean(slide.imageUrl))) {
        return;
      }

      slide.status = "submitting";
      slide.error = "";

      const pollKey = `${task.id}_slide_${slideIndex}_${Date.now()}`;
      const controller = new AbortController();
      this.controllers.set(pollKey, controller);

      try {
        const result = await submitXhsCarouselSlide(
          task.brandId!,
          task.trendId!,
          task.ideaIndex!,
          slideIndex,
          {
            carouselPack: task.carouselPack!,
            slide: slide as unknown as CarouselSlide,
            productImages: options.productImages,
            useBrandLogo: options.useBrandLogo,
            visualStylePreset: options.visualStylePreset,
            aspectRatio: task.aspectRatio || "3:4",
          },
          controller.signal,
        );
        if (result.user) auth.user = result.user;
        if (result.creditEventId) task.creditEventId = result.creditEventId;
        if (typeof result.carouselGroupId === "string") task.carouselGroupId = result.carouselGroupId;
        if (!result.slideJob?.jobId) throw new Error("小红书组图单页任务创建失败");

        slide.jobId = result.slideJob.jobId;
        slide.status = "polling";

        const concept = await pollImageJob(result.slideJob.jobId, {
          signal: controller.signal,
          onUser: (u) => {
            if (u) auth.user = u;
          },
        });

        slide.imageUrl = concept.imageUrl || concept.previewUrl;
        slide.previewUrl = concept.imageUrl || concept.previewUrl;
        slide.status = "completed";
        slide.error = "";

          if (concept.generationId) task.generationId = Number(concept.generationId);

          await auth.refreshUser().catch(() => {});
          await historyStore.refresh().catch(() => {});

          if (!task.completing && !task.completedAt && task.slides?.length === 4 && task.slides.every((s) => s.status === "completed" && Boolean(s.imageUrl))) {
            task.completing = true;
            task.status = "completed";
            task.completedAt = Date.now();
            void completeXhsCarousel(task.brandId!, task.trendId!, task.ideaIndex!, {
              carouselPack: {
                ...task.carouselPack!,
                carouselGroupId: task.carouselGroupId,
                slides: task.slides.map((s) => ({
                  title: s.title,
                  pageLabel: s.pageLabel,
                  copy: s.copy,
                  prompt: s.prompt,
                  visualDirection: s.visualDirection,
                  style: s.style,
                  composition: s.composition,
                  imageUrl: s.imageUrl || "",
                  previewUrl: s.imageUrl || "",
                })) as unknown as CarouselSlide[],
              },
              creditEventId: task.creditEventId ?? null,
            }).then((res) => {
              if (res.user) auth.user = res.user;
              void historyStore.refresh().catch(() => {});
            }).catch(() => {}).finally(() => { task.completing = false; });
          }
        } catch (error) {
          if (isAbortError(error) || controller.signal.aborted) return;
          slide.status = "failed";
          slide.error = (error as Error).message || "单页生成失败";
          await auth.refreshUser().catch(() => {});
        } finally {
          this.controllers.delete(pollKey);
        }
    },

    async generateAllCarouselSlides(
      taskId: string,
      options: {
        productImages: ProductImageInput[];
        useBrandLogo: boolean;
        visualStylePreset: string;
      },
    ): Promise<void> {
      const task = this.findTaskById(taskId);
      if (!task || !task.slides) return;

      const promises: Promise<void>[] = [];
      for (let i = 0; i < task.slides.length; i++) {
        const slide = task.slides[i];
        if (slide.status === "submitting" || slide.status === "polling" || (slide.status === "completed" && Boolean(slide.imageUrl))) {
          continue;
        }
        promises.push(this.generateCarouselSlide(taskId, i, options));
      }
      await Promise.all(promises);
    },

    async syncActiveServerJobs(): Promise<void> {
      const auth = useAuthStore();
      if (!auth.isLoggedIn) return;
      if (this.syncing) return;
      this.syncing = true;
      const gen = ++this.syncGeneration;

      try {
        const { jobs } = await fetchActiveImageJobs();
        if (gen !== this.syncGeneration || !auth.isLoggedIn) return;

        const jobList = Array.isArray(jobs) ? jobs : [];
        for (const job of jobList) {
          if (job.type === "xhsCarouselSlide" && job.carouselGroupId) {
            this.reconstituteCarouselJob(job);
          } else {
            this.reconstituteSingleJob(job);
          }
        }
      } catch (error) {
        if (isAbortError(error)) return;
      } finally {
        if (gen === this.syncGeneration) {
          this.syncing = false;
        }
      }
    },

    reconstituteSingleJob(job: RecoverableImageJob): void {
      const auth = useAuthStore();
      const historyStore = useHistoryStore();
      let task = this.tasks.find((t) => t.jobId === job.jobId || t.id === job.jobId);
      if (!task) {
        task = {
          id: job.jobId,
          jobId: job.jobId,
          type: (job.type as GenerationTaskType) || "moments",
          channelLabel: channelLabelForType((job.type as GenerationTaskType) || "moments"),
          brandId: job.brandId ?? null,
          trendId: job.trendId ?? null,
          ideaIndex: job.ideaIndex ?? null,
          brandName: "",
          trendTitle: "",
          ideaTitle: String(job.title || job.slide?.title || ""),
          cardTitle: String(job.title || job.slide?.title || "生图任务"),
          aspectRatio: job.aspectRatio || "3:4",
          status: job.status === "completed" ? "completed" : job.status === "failed" ? "failed" : "polling",
          createdAt: job.createdAt || Date.now(),
          imageUrl: job.imageUrl || job.slide?.imageUrl,
          previewUrl: job.imageUrl || job.slide?.imageUrl,
          error: job.error || "",
          generationId: job.generationId ?? null,
          viewed: false,
          copy: {
            caption: String(job.caption || job.slide?.copy || ""),
            visualDirection: String(job.visualDirection || job.slide?.visualDirection || ""),
            publishTitle: String(job.publishTitle || ""),
            intro: String(job.intro || ""),
          },
        };
        this.tasks.unshift(task);
      }

      if (task.status === "polling" && !this.controllers.has(job.jobId)) {
        const controller = new AbortController();
        this.controllers.set(job.jobId, controller);
        const targetTask = task;
        void (async () => {
          try {
            const concept = await pollImageJob(job.jobId, {
              signal: controller.signal,
              onUser: (u) => {
                if (u) auth.user = u;
              },
            });
            if (controller.signal.aborted) return;
            targetTask.status = "completed";
            targetTask.imageUrl = concept.imageUrl || concept.previewUrl;
            targetTask.previewUrl = concept.imageUrl || concept.previewUrl;
            if (concept.generationId) targetTask.generationId = Number(concept.generationId);
            targetTask.completedAt = Date.now();
            await auth.refreshUser().catch(() => {});
            await historyStore.refresh().catch(() => {});
          } catch (err) {
            if (isAbortError(err) || controller.signal.aborted) return;
            targetTask.status = "failed";
            targetTask.error = (err as Error).message || "图片生成失败";
            await auth.refreshUser().catch(() => {});
          } finally {
            this.controllers.delete(job.jobId);
          }
        })();
      }
    },

    reconstituteCarouselJob(job: RecoverableImageJob): void {
      const auth = useAuthStore();
      const historyStore = useHistoryStore();
      const groupId = String(job.carouselGroupId || "");
      if (!groupId) return;

      let task = this.tasks.find((t) => t.carouselGroupId === groupId);
      if (!task) {
        const slides: CarouselSlideItem[] = Array.from({ length: 4 }, (_, idx) => ({
          index: idx,
          pageLabel: `第 ${idx + 1} 张`,
          title: "",
          copy: "",
          prompt: "",
          status: "idle",
        }));

        task = {
          id: `xhs_${groupId}`,
          type: "xhsCarousel",
          channelLabel: "小红书组图",
          brandId: job.brandId ?? null,
          trendId: job.trendId ?? null,
          ideaIndex: job.ideaIndex ?? null,
          brandName: "",
          trendTitle: "",
          ideaTitle: String(job.carouselTitle || job.publishTitle || "小红书组图"),
          cardTitle: String(job.carouselTitle || job.publishTitle || "小红书组图"),
          aspectRatio: job.aspectRatio || "3:4",
          status: "polling",
          createdAt: job.createdAt || Date.now(),
          viewed: false,
          carouselGroupId: groupId,
          slides,
          copy: {
            publishTitle: String(job.publishTitle || ""),
            publishCaption: String(job.publishCaption || ""),
            caption: String(job.caption || ""),
          },
        };
        this.tasks.unshift(task);
      }

      const slideIndex = Number(job.slideIndex);
      if (Number.isInteger(slideIndex) && slideIndex >= 0 && slideIndex <= 3 && task.slides) {
        const slide = task.slides[slideIndex];
        if (slide) {
          slide.title = job.slide?.title || slide.title;
          slide.copy = job.slide?.copy || slide.copy;
          slide.prompt = job.slide?.prompt || slide.prompt;
          slide.pageLabel = job.slide?.pageLabel || slide.pageLabel;
          slide.visualDirection = job.slide?.visualDirection || slide.visualDirection;
          slide.style = job.slide?.style || slide.style;
          slide.composition = job.slide?.composition || slide.composition;
          slide.jobId = job.jobId;

          if (job.status === "completed") {
            slide.status = "completed";
            slide.imageUrl = job.imageUrl || job.slide?.imageUrl;
            slide.previewUrl = job.imageUrl || job.slide?.imageUrl;
          } else if (job.status === "failed") {
            slide.status = "failed";
            slide.error = job.error || "生成失败";
          } else {
            slide.status = "polling";
          }
        }
      }

      if (job.status === "pending" || job.status === "running") {
        const pollKey = `${groupId}_slide_${job.slideIndex}_${job.jobId}`;
        if (!this.controllers.has(pollKey)) {
          const controller = new AbortController();
          this.controllers.set(pollKey, controller);
          const targetTask = task;
          void (async () => {
            try {
              const concept = await pollImageJob(job.jobId, {
                signal: controller.signal,
                onUser: (u) => {
                  if (u) auth.user = u;
                },
              });
              if (controller.signal.aborted) return;
              const s = targetTask.slides?.[Number(job.slideIndex)];
              if (s) {
                s.status = "completed";
                s.imageUrl = concept.imageUrl || concept.previewUrl;
                s.previewUrl = concept.imageUrl || concept.previewUrl;
              }
              if (concept.generationId) targetTask.generationId = Number(concept.generationId);
              await auth.refreshUser().catch(() => {});
              await historyStore.refresh().catch(() => {});

              if (targetTask.slides?.length === 4 && targetTask.slides.every((sl) => sl.status === "completed" && Boolean(sl.imageUrl))) {
                targetTask.status = "completed";
                targetTask.completedAt = Date.now();
                if (targetTask.brandId != null && targetTask.trendId != null && targetTask.ideaIndex != null && !job.excellentRemix) {
                  void completeXhsCarousel(targetTask.brandId, targetTask.trendId, targetTask.ideaIndex, {
                    carouselPack: {
                      title: targetTask.cardTitle,
                      publishTitle: targetTask.copy?.publishTitle || "",
                      publishCaption: targetTask.copy?.publishCaption || "",
                      caption: targetTask.copy?.caption || "",
                      aspectRatio: targetTask.aspectRatio || "3:4",
                      carouselGroupId: groupId,
                      slides: targetTask.slides.map((sl) => ({
                        title: sl.title,
                        pageLabel: sl.pageLabel,
                        copy: sl.copy,
                        prompt: sl.prompt,
                        visualDirection: sl.visualDirection,
                        style: sl.style,
                        composition: sl.composition,
                        imageUrl: sl.imageUrl || "",
                        previewUrl: sl.imageUrl || "",
                      })) as unknown as CarouselSlide[],
                    },
                    creditEventId: targetTask.creditEventId ?? null,
                  }).catch(() => {});
                }
              }
            } catch (err) {
              if (isAbortError(err) || controller.signal.aborted) return;
              const s = targetTask.slides?.[Number(job.slideIndex)];
              if (s) {
                s.status = "failed";
                s.error = (err as Error).message || "生成失败";
              }
              await auth.refreshUser().catch(() => {});
            } finally {
              this.controllers.delete(pollKey);
            }
          })();
        }
      }
    },

    clear(): void {
      for (const ctrl of this.controllers.values()) {
        ctrl.abort();
      }
      this.controllers.clear();
      this.tasks = [];
      this.syncing = false;
    },
  },
});

onAuthReset(() => {
  try {
    const store = useGenerationTasksStore();
    store.clear();
  } catch {
    // pinia might not be ready
  }
});
