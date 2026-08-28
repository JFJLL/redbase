import { apiFetch } from "@/shared/api/client";

export type WhitelistedClientEventName =
  | "video_studio_opened"
  | "video_step_viewed"
  | "recharge_page_viewed"
  | "final_asset_downloaded";

export interface ClientEventMetadata {
  page?: string;
  step?: string;
  projectId?: number | string;
  planId?: string;
  assetType?: string;
  source?: string;
  [key: string]: unknown;
}

const seenKeys = new Set<string>();

export function trackAnalyticsEvent(
  eventName: WhitelistedClientEventName,
  metadata: ClientEventMetadata = {},
  options: { dedupeKey?: string } = {},
): Promise<void> {
  const dedupeKey = options.dedupeKey || `${eventName}:${JSON.stringify(metadata)}`;
  if (seenKeys.has(dedupeKey)) {
    return Promise.resolve();
  }
  seenKeys.add(dedupeKey);
  if (seenKeys.size > 2000) {
    const firstKey = seenKeys.values().next().value;
    if (firstKey) seenKeys.delete(firstKey);
  }

  return apiFetch("/api/analytics/events", {
    method: "POST",
    body: {
      eventName,
      metadata,
    },
  }).then(() => {}).catch((err) => {
    console.debug?.("[analytics] client event failed to send:", err);
  });
}
