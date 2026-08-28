import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useHistoryStore } from "@/features/history/stores/history";
import { useGenerationTasksStore } from "../stores/generationTasks";

describe("video project history placeholder deduplication", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("removes the local project placeholder after the matching server project arrives", () => {
    const tasksStore = useGenerationTasksStore();
    const historyStore = useHistoryStore();

    tasksStore.startVideoProjectTask({
      brandId: 1,
      trendId: 5,
      ideaIndex: 0,
      cardTitle: "同一个视频项目",
      projectId: 900,
      generationId: 901,
      videoStatus: "queued",
    });
    expect(tasksStore.placeholdersForHistory).toHaveLength(1);

    historyStore.replaceAll([{
      id: 901,
      type: "videoProject",
      channelLabel: "AI 视频",
      brandId: 1,
      trendId: 5,
      ideaTitle: "同一个视频项目",
      cardTitle: "同一个视频项目",
      createdAt: "2026-08-28T17:13:12.000Z",
      payload: {
        projectId: 900,
        sourceVideoScriptGenerationId: 88,
        videoStatus: "queued",
      },
    }]);

    expect(tasksStore.placeholdersForHistory).toHaveLength(0);
  });
});
