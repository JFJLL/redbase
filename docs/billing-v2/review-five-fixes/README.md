# 套餐与积分 V2 五项关键缺陷修复最终审查报告

## 一、终验测试执行与双基线数据对比

本轮终验于 **2026-10-20T03:54:46.544Z — 03:55:19.781Z** 完成全流程执行，原始日志均保存在 `outputs/review-five-fixes/`：

| 校验维度 | 验证命令与范围 | 实际结果与状态 | 核心凭据与数据 |
|---|---|---|---|
| **源码冻结性校验** | 涉及的 18 个代码、脚本和测试文件 | **通过** (exit 0) | PRE 与 POST 计算的 SHA-256 完全一致，`inFlightChangesDetected: false`。 |
| **代码格式与 Whitespace** | `git diff --check` | **通过** (exit 0) | 无空白字符异常，无冲突标记。 |
| **静态语法显式检查** | `node --check` 覆盖 9 个修改的服务端与脚本文件 | **通过** (exit 0) | 全部 9 个服务端与脚本文件语法合法，`npm run check`（含 postcheck）通过。 |
| **数据迁移演练** | `node scripts/rehearse-billing-migration.js` | **11 / 11 场景全过** (exit 0) | 覆盖全新建表至 V21 增量升级、幂等重跑与异常数据审计修复。 |
| **视频专项测试套件** | 4 个视频套件共 70 项测试 | **70 / 70 全过** (exit 0) | 见 `outputs/review-five-fixes/final-video-suites.log`，含 29.F 真实屏障同步加固。 |
| **新增计费审查套件** | 3 个新增测试文件共 46 项测试 | **46 / 46 全过** (exit 0) | 价格 10 项 + 溯源 16 项 + 退款 20 项，见 `final-billing-review.log`。 |
| **五项正向业务探针** | `node outputs/review-five-fixes/failing-before-regression.cjs` | **5 / 5 项全过** (exit 0) | 5 项正向业务断言在当前代码下全部转绿。 |
| **前端独立凭据** | 源码未变动（Tree `9a2671a719617cf8c2163df6e2cdaeaddfaece6e`） | **通过** (exit 0) | Vitest 412/412 全过，vue-tsc 0 错误，真实机器时间与日志见 `frontend-verification.json`。 |
| **后端全量测试比对** | `node scripts/run-node-tests.js tests` | **959 通过 / 4 失败** (exit 1) | 用例总数 963（净增 46 项），4 项失败完全复现基线已知签名，**未新增失败用例**。 |

### 基线与终验后端对比 (Baseline vs Final)
- **基线状态 (`b917e6e`, 隔离 detached 运行)**: 917 总计 / 913 通过 / 4 失败。
- **终验状态 (当前冻结工作区)**: 963 总计 / 959 通过 / 4 失败。
- **AnySearch 4 项已知失败签名对比**: 行号 1641（Pgy 错误码）、1660（定向修复布尔值）、2333（超时 480000 vs 80000）、2371（超时 480000 vs 80000）完全一致复现。未断言基线与工作区拥有相同本地私密配置，实证表明**无任何新增失败用例**。

---

## 二、原始五项问题闭环论证

1. **Fix 1: 退款守恒 (Exact Partial Refunds & Expiry Ledger)**
   - `refundVideoCredits` 严格按入参额度以 LIFO 逆序回补原扣费批次，已到期批次安全转入到期总账，总额度与区间上限严密校验防超退；旧用例夹具加固且无断言降级。
2. **Fix 2: 价格不可变性 (Frozen Purchase Prices)**
   - 按冻结的报价与订单快照中的完整周期基准价计算后续升级差额，目录调价不改写存量订阅的成交基准。
3. **Fix 3: 取消排期隔离 (Unique Activated Paid/Fulfilled Schedule Source)**
   - 排期检索增加有效状态过滤，仅采纳已付款/已履约的合法排期，彻底排除已取消（`cancelled`）或无效排期，消除 700 错误配额恢复。
4. **Fix 4: CAS 乐观并发保护 (CAS Reject & Safe Abort)**
   - `safeUpdateSubscriptionSnapshot` 在并发版本冲突时明确返回 `false`，方案档位冲突时拒绝写入；慢速读取不再覆盖已生效的高级套餐快照。
5. **Fix 5: 迁移存证保护 (V18–V21 Preimage Audit & Preserve Unresolved)**
   - 引入 Migration 21 与 `subscription_snapshot_audits` 审计表；对历史无法溯源但结构合规的快照完整保留前像存证（`preserve_unresolved`），同时 `createQuote` 维持安全阻断拦截未决自动报价。

---

## 三、夹具加固与 29.F 屏障同步说明

- **29.F 并发测试加固 (`tests/video-production-recovery-boundaries.test.js`)**:
  - 原测试在异步触发后依赖固定的 `setTimeout(50ms)`，在系统负载波动时偶发状态未完成；
  - 现重构为显式提供方挂起屏障（`barrierPromise` / `releaseBarrier`），精确模拟并发竞争，并在释放后采用有界轮询等待异步落盘完成；
  - 关键断言 `status === 'completed'` 与 `providerGetStatusCalls === 1` **严格保持不变，绝无放宽或弱化断言**。
- **初次失败记录留存**: 终验首次执行的原始日志已完整备份于 `outputs/review-five-fixes/initial-final-*`，供对账审计查验。

---

## 四、历史数据边界与交付约束

1. **历史无来源数据处理边界**: 历史已抹除且完全缺失批次关联证据的数据遵循客观事实，严禁凭空伪造来源，系统保留结构存证并阻断自动报价，转交客服人工核查。
2. **验证范围**：本报告的测试及迁移结论来自合成/内存数据库，不代表生产数据已完成核对。未进行真实付款或生产部署。
3. **交付范围**：本轮仅提交并推送功能分支 codex/billing-v2-subscription-wallet，不合并 master，不部署生产。
