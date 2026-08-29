export type AdminSection =
  | "overview"
  | "users"
  | "features"
  | "ai"
  | "finance"
  | "system"
  | "management";

export type AdminDatePreset = "today" | "7d" | "30d" | "90d" | "custom";

export interface AdminFilters {
  preset: AdminDatePreset;
  customFrom?: string;
  customTo?: string;
  accountType?: "customer" | "yimei" | "";
}

export interface CoverageInfo {
  trackingStartedAt?: string;
  clientTrackingStartedAt?: string;
  backfillCompletedAt?: string;
  isPartial?: boolean;
  notes?: string[];
}

export interface KpiMetric {
  value: number | null;
  prevValue?: number | null;
  deltaPercent?: number | null;
  sampleSize?: number;
}

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface OverviewResponse {
  generatedAt: string;
  range: { from: string; to: string; timezone: string; accountType?: string };
  comparisonRange: { from: string; to: string };
  coverage: CoverageInfo;
  kpis: {
    dau: KpiMetric;
    newUsers: KpiMetric;
    effectiveCreators: KpiMetric;
    payingUsers: KpiMetric;
    revenueYuan: KpiMetric;
    outputs: KpiMetric;
    netCredits: KpiMetric;
    aiSuccessRate: KpiMetric;
  };
  trends: {
    dauSeries: TimeSeriesPoint[];
    newUsersSeries: TimeSeriesPoint[];
    creatorsSeries: TimeSeriesPoint[];
    revenueSeries: TimeSeriesPoint[];
    outputsSeries: TimeSeriesPoint[];
  };
  featureDistribution: Array<{
    feature: string;
    label: string;
    count: number;
    usersCount: number;
  }>;
}

export interface FunnelStep {
  step: string;
  count: number;
  rate: number | null;
}

export interface UsersResponse {
  generatedAt: string;
  range: { from: string; to: string; timezone: string; accountType?: string };
  coverage: CoverageInfo;
  activity: {
    todayDau: number;
    wau: number;
    mau: number;
  };
  mainFunnel: FunnelStep[];
  videoFunnel: FunnelStep[];
  retention: {
    cohortSize: number;
    d1CohortSize: number;
    d7CohortSize: number;
    d30CohortSize: number;
    d1Rate: number | null;
    d7Rate: number | null;
    d30Rate: number | null;
  };
  accountDistribution: Array<{
    accountType: string;
    label: string;
    count: number;
  }>;
}

export interface FeatureStatItem {
  feature: string;
  label: string;
  usersCount: number;
  requestsCount: number;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  grossCredits: number;
  refundCredits: number;
  netCredits: number;
  avgRequestsPerUser: number;
  trend: TimeSeriesPoint[];
}

export interface FeaturesResponse {
  generatedAt: string;
  range: { from: string; to: string; timezone: string; accountType?: string };
  coverage: CoverageInfo;
  features: FeatureStatItem[];
  failureReasons: Array<{
    stage: string;
    code: string;
    count: number;
  }>;
}

export interface AiBreakdownItem {
  feature: string;
  featureLabel: string;
  provider: string;
  model: string;
  requestsCount: number;
  successRate: number | null;
  avgDurationMs: number;
  tokensTotal: number;
  retryCount: number;
}

export interface VideoComparisonItem {
  model: string;
  mode: string;
  resolution: string;
  aspectRatio: string;
  totalDurationSec: number;
  projectCount: number;
  matureCount: number;
  activeCount: number;
  waitingConfigCount: number;
  completionRate: number | null;
  firstSuccessRate: number | null;
  autoRetryRate: number | null;
  manualRetryRate: number | null;
  rescueRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  grossCredits: number;
  refundCredits: number;
  netCredits: number;
  avgNetCredits: number | null;
  netCreditsPerSuccessSecond: number | null;
  vendorCost: string | null;
  vendorCostLabel: string;
}

export interface AiResponse {
  generatedAt: string;
  range: { from: string; to: string; timezone: string };
  coverage: CoverageInfo;
  summary: {
    totalRequests: number;
    completedCount: number;
    failedCount: number;
    successRate: number | null;
    retryRate: number | null;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
  };
  breakdown: AiBreakdownItem[];
  errorStages: Array<{ stage: string; count: number; percent: number | null }>;
  topErrorCodes: Array<{ code: string; stage: string; count: number; sampleMessage?: string }>;
  videoComparison: VideoComparisonItem[];
}

export interface FinanceResponse {
  generatedAt: string;
  range: { from: string; to: string; timezone: string; accountType?: string };
  coverage: CoverageInfo;
  overview: {
    revenueYuan: number;
    payingUsers: number;
    arppu: number;
    totalOrders: number;
    paidOrders: number;
    paidInPeriod: number;
    createdInPeriod: number;
    cohortPaid: number;
    pendingUnexpired: number;
    expiredOrFailed: number;
    conversionRate: number | null;
    currentRemainingCredits: number;
    adminGrantedCredits: number;
    auditIssuesCount: number;
  };
  channelComparison: Array<{
    provider: string;
    providerLabel: string;
    totalOrders: number;
    paidOrders: number;
    revenueYuan: number;
  }>;
  planDistribution: Array<{
    planId: string;
    planName: string;
    ordersCount: number;
    revenueYuan: number;
  }>;
  revenueSeries: TimeSeriesPoint[];
}

export interface SystemResponse {
  generatedAt: string;
  coverage: CoverageInfo;
  database: {
    databaseAvailable: boolean;
    dbSizeBytes: number;
    pageCount: number;
    pageSize: number;
  };
  imageJobs: {
    pending: number;
    running: number;
    failedLast24h: number;
    oldestActiveAgeSec: number;
    stuckCount: number;
  };
  videoJobs: {
    schedulerRunning: boolean;
    activeProjectCount: number;
    queueDepthByStatus: Record<string, number>;
    oldestQueuedAgeSec: number;
    oldestActiveAgeSec: number;
    stuckCount: number;
    d2Submission: { active: number; limit: number };
    mediaProcessing: { active: number; limit: number };
    ffmpeg: { active: number; limit: number };
    agnes: { keyTotal: number; healthy: number; cooldown: number; degraded: number; inFlight: number };
    actionable: {
      waitingConfiguration: number;
      resultProcessingFailed: number;
      partialFailed: number;
      uncertain: number;
      assemblyFailed: number;
    };
  };
  payment: {
    auditCount: number;
    pendingExpiredCount: number;
    failedLast24h: number;
  };
  assetPurge: {
    purgedGenerationCount: number;
    purgedAssetCount: number;
    purgedBytes: number;
    purgeFailedCount: number;
    lastPurgeAt: string;
  };
  ai: {
    errorsLast24h: number;
    successRateLast24h: number | null;
    p95LatencyLast24h: number | null;
  };
  alerts: Array<{ level: "info" | "warning" | "error"; message: string }>;
}

export interface PaginatedResult<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface AdminUserItem {
  id: number;
  name: string;
  phone: string;
  accountType: string;
  department?: string;
  credits: number;
  createdAt: string;
  brandCount: number;
  generationCount: number;
  consumedTokens: number;
  grantedTokens: number;
}

export interface AdminBrandItem {
  id: number;
  ownerUserId: number;
  name: string;
  industry: string;
  audience?: string;
  description?: string;
  product?: string;
  goal?: string;
  profileType: string;
  createdAt: string;
  updatedAt?: string;
  analysisCount: number;
  trendCount: number;
  user?: { id: number; name: string; phone: string } | null;
}

export interface AdminGenerationItem {
  id: number;
  ownerUserId: number;
  type: string;
  channelLabel: string;
  brandId: number;
  brandName: string;
  trendId: number;
  trendTitle: string;
  ideaTitle?: string;
  cardTitle: string;
  createdAt: string;
  previewUrl?: string;
  summary?: string;
  visibilityStatus: "active" | "expired";
  assetStatus: "available" | "purged" | "none" | "purge_failed";
  assetCount: number;
  assetBytes: number;
  assetsDeletedAt?: string;
  user?: { id: number; name: string; phone: string } | null;
}

export interface AdminCreditEventItem {
  id: number;
  userId: number;
  actionType: string;
  actionLabel: string;
  creditDelta: number;
  creditCost: number;
  createdAt: string;
  adminUserId?: number;
  adminUserName?: string;
  brandId?: number;
  brandName?: string;
  trendId?: number;
  trendTitle?: string;
  ideaTitle?: string;
  generationId?: number;
  channelLabel?: string;
  summary?: string;
  user?: { id: number; name: string; phone: string } | null;
}

export interface AdminPaymentOrderItem {
  id: number;
  outTradeNo: string;
  userId: number;
  planId: string;
  planName: string;
  planCredits: number;
  amountFen: number;
  amountYuan: number;
  status: string;
  provider: string;
  tradeNo?: string;
  creditEventId?: number;
  createdAt: string;
  paidAt?: string;
  expiresAt?: string;
  auditReason?: string;
  user?: { id: number; name: string; phone: string } | null;
}

export interface AdminVideoProjectItem {
  id: number;
  ownerUserId: number;
  generationId: number;
  requestId: string;
  model: string;
  mode: string;
  resolution: string;
  aspectRatio: string;
  totalDurationSec: number;
  status: string;
  estimatedCredits: number;
  chargedCredits: number;
  refundedCredits: number;
  netCredits: number;
  assetStatus: string;
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
  user?: { id: number; name: string; phone: string } | null;
}

export interface AdminVideoClipItem {
  id: number;
  clipIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  status: string;
  prompt?: string;
  provider?: string;
  attempt?: number;
  retryCount?: number;
  error?: string;
  firstSubmittedAt?: string;
  completedAt?: string;
  failedAt?: string;
  assetStatus?: string;
}

export interface AdminVideoProjectDetail extends AdminVideoProjectItem {
  startedAt?: string;
  assemblyStartedAt?: string;
  assemblyCompletedAt?: string;
  assetCount?: number;
  assetBytes?: number;
  assetsDeletedAt?: string;
  scriptConcept?: string;
  hasFinalVideo?: boolean;
  clips: AdminVideoClipItem[];
}
