# BLOCKED

- 基线 `npm test` 存在 1 个既有失败（tests/text-provider.test.js:283，Windows/Node24 计时敏感，探针证实为定时器粒度导致的环境性失败，非逻辑回归）。已以等比放大时间刻度方式修复，语义保持“重试共享一个超时预算”。若这被认为属于“放宽旧断言”，请复核；本人判断是修复环境不稳定测试而非放宽验收。
- warnings 无法持久化到数据库（任务禁止改 schema/migration）：分析记录中的 `warnings` 字段在 snapshot 归一化时被丢弃，replay 响应中的 warnings 回落为空数组。首次成功响应已携带完整 warnings，replay 的核心语义（不重复扣分、不重复生成）不受影响。如需 replay 也带 warnings，需要 schema 变更，超出本次界限。
- `canUseFinalFieldScopedTrendRepair` 在新循环里不再被调用（原“第三次字段级修补”入口被 2 次调用上限取代），函数保留未删（顺手删除属顺手重构，按界限记录于此，未执行）。

（其余无）
