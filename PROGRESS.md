# PROGRESS — RedBase 前端 Vue 3 重构（总控账本）

## 十行纲要（任务0核对后）
1. 目标：原生前端迁移为 Vue3+Vite+TS 三入口（`/`、`/app/`、`/admin/`），官网不加载工作台代码，后端/DB/API 语义不变。
2. 并行边界：总控改根 package*、config.js、static.js、deploy/、scripts/、docs/、frontend 公共层；Core=landing/auth/brands/personal；Insights=trends/ideas；Content=excellent/generation/history/admin。
3. 业务 Agent 禁改 lockfile、Vite 配置、公共 router/store、Node 服务、部署文件；变更诉求写 BLOCKED.md。
4. 顺序：任务0基线 → 任务1公共骨架+基础commit+三worktree → 任务2三Agent并行 → 任务3按 Core→Insights→Content 合并 → 性能收口 → 部署流程 → 双Node验收。
5. 冲突让步序：数据正确与功能不变 > Node 20.20.0 可构建 > 加载速度 > 开发方便。
6. 最大风险：旧 app.js(265KB)业务逻辑密集，迁移遗漏字段/错误提示/权限行为；其次是 Node 20.20.0 无法本机复现，需以 engines 核验+服务器实测兜底。
7. 资源预算：官网初始 JS+CSS gzip ≤100KB；工作台公共初始 JS gzip ≤250KB；每业务路由独立 chunk；预算脚本机器可判。
8. 构建产物先进临时目录，Node 脚本原子替换 dist/public；构建失败不重启服务；本地未构建回退旧 public。
9. 测试红线：总数 ≥ 基线(单元433+集成176)，跳过=0；禁止 skip/删测试/放宽断言/调高预算。
10. 验收：双 Node 全绿 + 三入口烟测 + 预算通过 + 一次故意红灯与还原绿灯，最多3轮集成验收。

## 任务0 基线（2026-07-27，开发机 Node 24.11.1 / npm 11.13.0）
- git status --short：干净（无输出）
- 分支：codex/frontend-vue-rebuild @ 0ff96b5ae5ff6f025b1724918387fb8aaa9e5c02（与 master 同 SHA；差异说明见 BLOCKED.md 顶部）
- npm ci：通过（added 39 packages；此前需停掉自 7/24 运行的本地 `node server.js` PID 40268，它锁住 better_sqlite3.node）
- npm run check：通过（node --check 全部文件）
- npm test：tests 433 / pass 433 / fail 0 / skipped 0 / todo 0
- npm run test:integration：tests 176 / pass 176 / fail 0 / skipped 0 / todo 0
- 旧资源字节数：index.html 57952；app.js 271187；styles.css 107793；landing-v3.css 33606；admin.js 27117
- npm view vite engines → {"node": "^20.19.0 || >=22.12.0"}（含 Node 20.20.0 与 24.11.1）
- npm view @vitejs/plugin-vue engines → {"node": "^20.19.0 || >=22.12.0"}
- 备注：npm.ps1 在本会话 shell 有编码 bug，统一使用 npm.cmd 调用。

## 状态账本（每完成一项立即更新）
- [x] 任务0：基线采集与核对
- [x] 任务0：PROGRESS.md / BLOCKED.md 建立
- [x] 任务1：frontend/ 公共骨架（三入口 Vite+TS+Router+Pinia+Vitest；typecheck 通过、12 个前端测试全绿、构建通过）
- [x] 任务1：static.js 改造（dist/public 优先、/app//admin SPA 刷新、旧 public 回退；新增 5 个后端测试，npm test 438/438、跳过 0）
- [x] 任务1：scripts/build-frontend.cjs（临时目录构建+原子替换+失败不动线上目录）与 scripts/check-asset-budget.cjs（预算首跑 PASS：官网 1.2KB/100KB，工作台共享 37.9KB/250KB，10 业务路由全部懒加载）
- [x] 任务1：基础 commit + 三个 worktree（基础 commit 48e137b64795c57335d751ec26983777ffe799e9；worktree：.worktrees/core=codex/fe-core、.worktrees/insights=codex/fe-insights、.worktrees/content=codex/fe-content，均已装好 frontend 依赖）
- [x] 任务2：Core Agent 交付（commit 146c899 → 二轮无追加；landing/auth/brands/personal 迁移，含飞书登录、品牌 CRUD+产品图上传、个人 IP）
- [x] 任务2：Insights Agent 交付（commit eab2b11 + edec753 preselect brand；trends 轮询/证据链/机会点，ideas 选题生成与编辑）
- [x] 任务2：Content Agent 交付（commit 0fd65d4 + ce894a0 生图四通道与产品图；excellent+remix、generation、history、admin）
- [x] 任务3：按序合并（Core→Insights→Content，BLOCKED.md 冲突已手工合并）+ 删除旧入口（public/index.html/app.js/styles.css/landing-v3.css/admin.*/js；根 check 脚本去掉 public 引用，commit 42ed604）
- [x] 任务3：旧前端契约测试迁移（18 个失败测试同强度迁到 Vue 实现；commit 0edaf1b；root 388/388、integration 176/176、frontend 135/135，跳过均 0，总数 523 ≥ 基线 521；6 条缺口已上报 BLOCKED.md）
- [x] 任务3：性能收口（系统中文字体栈、无 Google Fonts；首屏图 eager+fetchpriority、非首屏 lazy；预算脚本 PASS：官网 15.4KB/100KB、工作台 39.5KB/250KB、10 路由懒加载、官网无 Vue chunk）
- [x] 任务3：部署流程更新（scripts/deploy-server.sh：干净区→拉 master→双 npm ci→临时目录构建原子切换→check/test/integration/frontend/budget→pm2 restart→四路径烟测，失败前置中止；README 部署章节同步；deploy/nginx 全量代理 Node 无需改）
- [x] 完成条件：双 Node 验证 + 红绿灯演示 + 最终提交（见下）

## 验收证据（对话已贴实际输出）
- 开发机 Node 24.11.1：npm ci ✓、check ✓、npm test 388/388、integration 176/176、frontend 135/135（跳过均 0）、build ✓、budget PASS、三入口+SPA刷新+favicon 烟测全 200、官网无 base/app chunk。
- 真实 Node 20.20.0（D:\Tools\nvm\v20.20.0，独立 worktree .worktrees/node20）：npm ci（后端+前端）✓、check ✓、node --test tests 388/388、integration 176/176、frontend typecheck 0 错误、vitest 135/135（跳过均 0）、build-frontend 原子替换 ✓、budget PASS。
- 红灯→绿灯演示①（预算）：官网 main.ts 强行 import vue → budget FAIL（landing shares chunk … must not load Vue，exit 1）；还原后 PASS。
- 红灯→绿灯演示②（原子替换）：landing 注入 TS 类型错误 → build 在 typecheck 阶段失败 exit 1、dist/public 未被触碰（untouched=True）；还原后 build exit 0。
- 测试总数：root 388 + integration 176 + frontend 135 = 699（原生前端 68 个契约用例已 1:1 迁入 frontend），跳过 0；均 ≥ 基线。

## 决策与“建议”替换记录
- 依赖精确版本（均经 registry engines 核验兼容 Node 20.20.0 与 24.11.1）：vue@3.5.40、vue-router@4.6.4、pinia@3.0.4、vite@7.3.6、@vitejs/plugin-vue@6.0.8、typescript@5.9.3、vue-tsc@3.3.8、vitest@4.1.10、@vue/test-utils@2.4.11、happy-dom@20.11.1、@types/node@20.19.43。
- 选 vue-router@4 + pinia@3 而非最新 5/4 大版本：5.x/4.x 发布过新且互相强绑（router5 peer 要求 pinia3/4+vite7/8），成熟线风险更低；engines 均无限制。
- 选 vite@7.3.6 而非 8.1.5：8 为最新大版本生态验证不足；两者 engines 相同（^20.19.0 || >=22.12.0），vitest4/plugin-vue6 同时兼容 6/7/8，后续升级不受阻。
- “浏览器测试”基础设施：沿用仓库既定的 Kimi WebBridge 浏览器验收门（AGENTS.md），不引入 Playwright 重依赖；单元/组件测试用 vitest+happy-dom；三入口烟测走 HTTP 探测。原因：减少新增二进制依赖对服务器 Node 20.20.0 环境的风险。
- 旧 /assets/* 非哈希图片（logo、landing 图、favicon、二维码）继续由 public/assets 提供：构建时合并复制进 dist/public/assets，避免在 frontend/ 重复提交 6MB 二进制。
- 工作台外壳（WorkspaceShell/Home/NotFound）按“公共组件”由总控实现并冻结在 src/app/，Core Agent 不需要改公共 router 即可完成登录/品牌/个人 IP 迁移。
- worktree 建在仓库内 .worktrees/（已 gitignore）而非仓库外：文件工具沙箱禁止写 workspace 之外的路径。遗留空目录 D:\download\pic-vec\redbase-wt-{core,insights,content} 已从 git 注销但沙箱无法删除文件夹，可手工清理。
