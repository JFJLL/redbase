export const FEATURE_LABELS: Record<string, string> = {
  trend_analysis: "趋势分析",
  excellent_direction: "优秀内容方向",
  excellent_fusion: "优秀内容融合",
  moments: "朋友圈",
  wechat_long_image: "公众号长图",
  xhs_carousel: "小红书组图",
  style_image: "风格图",
  image_edit: "图片编辑",
  video_script: "视频脚本",
  video_project: "AI 视频",
};

export const ERROR_STAGE_LABELS: Record<string, string> = {
  validation: "参数与前置校验",
  billing: "计费与积分冻结",
  submission: "任务提交阶段",
  provider: "模型供应商执行",
  poll: "状态轮询阶段",
  download: "生成媒体下载",
  persist: "媒体资产持久化",
  frame_extract: "首尾连续帧提取",
  assembly: "FFmpeg 视频拼接",
  configuration: "密钥与配置阻塞",
  cancelled: "已取消",
  unknown: "未知阶段",
};

export const STATUS_LABELS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  completed: { label: "已完成", tone: "success" },
  paid: { label: "已付款", tone: "success" },
  active: { label: "正常生效", tone: "success" },
  available: { label: "媒体可用", tone: "success" },
  running: { label: "运行中", tone: "info" },
  preparing: { label: "准备中", tone: "info" },
  queued: { label: "排队中", tone: "info" },
  assembling: { label: "正在拼接", tone: "info" },
  processing_result: { label: "处理结果", tone: "info" },
  pending: { label: "待处理", tone: "warning" },
  waiting_configuration: { label: "配置阻塞", tone: "warning" },
  result_processing_failed: { label: "结果保存失败", tone: "warning" },
  partial_failed: { label: "部分分镜失败", tone: "warning" },
  uncertain: { label: "状态不明确", tone: "warning" },
  assembly_failed: { label: "拼接失败", tone: "warning" },
  failed: { label: "失败", tone: "danger" },
  project_data_failed: { label: "数据异常失败", tone: "danger" },
  purge_failed: { label: "清理失败", tone: "danger" },
  expired: { label: "已过期", tone: "neutral" },
  purged: { label: "媒体已清理", tone: "neutral" },
  none: { label: "无媒体", tone: "neutral" },
  cancelled: { label: "已取消", tone: "neutral" },
  closed: { label: "已关闭", tone: "neutral" },
};

export function getStatusMeta(status: string) {
  return STATUS_LABELS[status] || { label: status || "未知", tone: "neutral" as const };
}
