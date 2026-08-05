import { describe, expect, it } from "vitest";
import BrandsViewSource from "@/features/brands/views/BrandsView.vue?raw";
import TrendsViewSource from "@/features/trends/views/TrendsView.vue?raw";
import ExcellentViewSource from "@/features/excellent/views/ExcellentView.vue?raw";
import HistoryViewSource from "@/features/history/views/HistoryView.vue?raw";

// 视觉回归契约（2026-08-05 交接基线）：
// 旧版 D:\download\redbase\public\styles.css 的密度约束必须以 CSS 形式存在，
// 而不是靠字符串截断数据。这里用视图源码哨兵锁定约束，防止后续迁移丢失。
describe("workspace visual-regression CSS contract", () => {
  it("品牌长档案不再撑满页面：描述区 max-height/min-height 150px，标题两行 clamp", () => {
    expect(BrandsViewSource).toContain("max-height: 150px");
    expect(BrandsViewSource).toContain("overflow: hidden");
    expect(BrandsViewSource).toContain("min-height: 150px");
    expect(BrandsViewSource).toContain("-webkit-line-clamp: 2");
    // 卡片头部需要 min-width:0，否则长单词会把网格卡撑破。
    expect(BrandsViewSource).toMatch(/min-width:\s*0/);
  });

  it("趋势顶部说明完整位于提示卡内：行高 1.8、下边距 22px、可换行", () => {
    expect(TrendsViewSource).toContain("line-height: 1.8");
    expect(TrendsViewSource).toContain("margin-bottom: 22px");
    // 长品牌名/连续文本不得横向溢出卡片。
    expect(TrendsViewSource).toMatch(/overflow-wrap|word-break/);
  });

  it("优秀内容卡片标题最多两行（line-clamp 2），列表节奏不被超长标题破坏", () => {
    expect(ExcellentViewSource).toMatch(/excellent-card-body h3[\s\S]*?line-clamp:\s*2/);
    expect(ExcellentViewSource).toContain("-webkit-box-orient: vertical");
  });

  it("历史生成桌面两列网格、移动单列；标题两行/引用一行/正文三行；组图 2×2；单图 16:10", () => {
    expect(HistoryViewSource).toContain("history-generate-list");
    expect(HistoryViewSource).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(HistoryViewSource).toMatch(/line-clamp:\s*2/);
    expect(HistoryViewSource).toMatch(/line-clamp:\s*1/);
    expect(HistoryViewSource).toMatch(/line-clamp:\s*3/);
    expect(HistoryViewSource).toContain("aspect-ratio: 16 / 10");
    // 移动端单列、无横向溢出。
    expect(HistoryViewSource).toMatch(/@media \(max-width: 760px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("历史组图预览是 2×2 而不是单行四张", () => {
    // 组图区必须是两列网格（旧版 .history-generate-grid），不能是四列平铺。
    expect(HistoryViewSource).toContain("repeat(2, minmax(0, 1fr))");
    expect(HistoryViewSource).not.toContain("repeat(4, minmax(0, 1fr))");
  });

  it("优秀内容详情恢复旧版双列阅读弹窗：左图右文、正文自身滚动", () => {
    expect(ExcellentViewSource).toContain("excellent-detail-modal-panel");
    expect(ExcellentViewSource).toContain("excellent-detail-layout");
    expect(ExcellentViewSource).toContain("grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr)");
    expect(ExcellentViewSource).toContain("excellent-detail-copy");
    expect(ExcellentViewSource).toContain("excellent-detail-metrics");
    expect(ExcellentViewSource).toMatch(/excellent-detail-body[\s\S]*?max-height:\s*220px/);
    expect(ExcellentViewSource).toContain("查看原笔记");
  });

  it("仿图文弹窗恢复旧版分区式工作流：编号分区、模式 tabs、方向卡、融合卡、素材区", () => {
    expect(ExcellentViewSource).toContain("excellent-remix-modal-panel");
    expect(ExcellentViewSource).toContain("1. 参考笔记");
    expect(ExcellentViewSource).toContain("2. 选择内容主体");
    expect(ExcellentViewSource).toContain("3. 想重点学习什么");
    expect(ExcellentViewSource).toContain("4. 内容方向");
    expect(ExcellentViewSource).toContain("5. 融合方案");
    expect(ExcellentViewSource).toContain("6. 素材使用方式");
    expect(ExcellentViewSource).toContain("excellent-mode-tabs");
    expect(ExcellentViewSource).toContain("excellent-direction-card");
    expect(ExcellentViewSource).toContain("excellent-fusion-card");
    expect(ExcellentViewSource).toContain("excellent-asset-block");
    expect(ExcellentViewSource).toContain("remix-open-product-picker");
    expect(ExcellentViewSource).toContain("excellent-originality-note");
  });
});
