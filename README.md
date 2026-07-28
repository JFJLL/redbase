# RedBase

小红书内容运营工具，本地运行版本。

## 当前状态

- 不再内置预置品牌或趋势演示数据
- 趋势分析与选题改写走真实文本模型
- 一键生图走真实图片服务
- 数据持久化到 `data/redbase.sqlite`
- 后端已拆到 `src/server/*`
- 浏览器会话使用 HttpOnly Cookie；普通 API 不再通过 URL 传 session token
- 受保护图片/资产 URL 使用短时签名
- 主要业务写路径已迁移到 SQLite 仓库操作，避免每个请求全量读写数据库

## 目录

```text
.
├─ public/            前端静态资源
├─ src/server/        Node 服务端模块
├─ data/              SQLite 数据文件
├─ docs/              项目文档
├─ deploy/nginx/      nginx 配置
├─ package.json
└─ server.js          启动入口
```

## 模型配置

生产和本地运行使用项目根目录下被 Git 忽略的 `.env` 保存密钥，非敏感参数继续放在 `config.local.json`。服务启动时会自动加载 `.env`；部署服务器时需单独同步该文件，不要提交到仓库。

```dotenv
ANYSEARCH_API_KEYS=<key-1>,<key-2>
```

飞书多企业登录示例：

```json
{
  "feishu": {
    "enabled": true,
    "apps": [
      {
        "key": "yimei",
        "name": "易美传播",
        "appId": "<yimei-feishu-app-id>",
        "appSecret": "<yimei-feishu-app-secret>",
        "tenantKeys": ["<yimei-tenant-key>"]
      },
      {
        "key": "hongmo",
        "name": "弘摩科技",
        "appId": "<hongmo-feishu-app-id>",
        "appSecret": "<hongmo-feishu-app-secret>",
        "tenantKeys": ["<hongmo-tenant-key>"]
      }
    ],
    "baseUrl": "https://redbase.red-magic.cn"
  }
}
```

常用配置项：

- `textProvider.apiStyle`：文本模型接口类型，默认 `openai`
- `textProvider.model`：文本模型名，默认 `deepseek/deepseek-v4-flash`
- `textProvider.rerankModel` / `TREND_RERANK_MODEL`：趋势证据重排使用的低成本模型；未配置时复用 `textProvider.model`，走同一文本服务接口
- `textProvider.baseUrl`：Google 风格文本接口地址，仅兼容旧配置
- `textProvider.openaiBaseUrl`：OpenAI 兼容接口地址，默认 `https://llm.runninghub.ai/v1`
- `textProvider.anthropicBaseUrl`：Anthropic 兼容接口地址
- `textProvider.apiKey`：文本模型 API Key
- `textProvider.useImageProviderApiKey`：文本服务是否复用图片服务 API Key；当前 RunningHub 配置为 `true`
- `textProvider.searchEnabled`：是否启用模型内置搜索；当前关闭，趋势证据改由 AnySearch 提供
- `searchProvider.enabled`：是否启用 AnySearch；非小红书趋势维度启用后才会生成，来源不足时直接中止
- `ANYSEARCH_API_KEYS`：推荐的多 Key 配置，写在项目根目录 `.env` 中并用逗号分隔；运行时按当日已用量最少的 Key 分流
- `ANYSEARCH_API_KEY`：单 Key 兼容配置；`searchProvider.apiKey`、`apiKeyFile`、`apiKeyFiles` 仅保留给旧部署兼容
- `searchProvider.domain` / `searchProvider.subDomain`：网页检索路由，默认 `general` / `general.general`
- `searchProvider.socialEnabled`：是否补充社交媒体信号；社会话题检索微博和知乎，其它适用维度补充知乎
- `searchProvider.socialDomain` / `searchProvider.socialSubDomain`：社媒检索路由，默认 `social_media` / `social_media.social_media`
- `searchProvider.maxSocialEvidence`：每次最多送入模型的社媒证据数，默认 `2`；社媒只表达讨论与情绪，不能单独支撑政策、数据或功效事实
- `searchProvider.minReliableEvidence`：每次生成至少需要的高/中可信网页来源数，默认 `2`
- `searchProvider.dailyQueryLimit`：每个 Key 按批次内子查询计数的每日硬上限，默认 `950`；两个 Key 合计上限 `1900`。超时和 5xx 重试也按一次外发搜索计数，避免项目记录低于供应商实际消耗
- `searchProvider.dailyUsageFile`：每日用量状态文件，默认 `data/anysearch-usage.json`；重启服务后仍会延续当日计数
- `searchProvider.maxCacheEntries`：进程内证据缓存最多保留的查询组数，默认 `100`；过期条目会主动清理
- `imageProvider.baseUrl`：图片生成接口地址
- `imageProvider.editBaseUrl`：图片编辑接口地址
- `imageProvider.uploadBaseUrl`：图片上传接口地址
- `imageProvider.model`：图片模型名，默认 `gpt-image-2`
- `imageProvider.apiKey`：图片模型 API Key
- `imageProvider.aspectRatio`、`imageProvider.resolution`、`imageProvider.quality`、`imageProvider.imageCount`：图片参数
- `admin.phones`：管理员手机号，多个放在数组中
- `feishu.enabled`：是否启用飞书企业登录；配置了飞书凭据时默认启用
- `feishu.apps`：飞书应用列表；每个企业自建应用一项
- `feishu.apps[].key`：前端登录入口和 OAuth state 使用的稳定标识，只用英文、数字、短横线或下划线
- `feishu.apps[].name`：登录按钮显示名称
- `feishu.apps[].appId` / `feishu.apps[].appSecret`：该企业自建应用的 OAuth 凭据
- `feishu.apps[].tenantKeys`：该应用允许登录的飞书企业 `tenant_key` 白名单
- `feishu.appId` / `feishu.appSecret` / `feishu.tenantKey` / `feishu.tenantKeys`：单应用旧配置，仍兼容；配置 `feishu.apps` 后优先使用多应用列表
- `feishu.baseUrl`：飞书 OAuth 回调使用的外部访问地址，生产环境应配置为公网 HTTPS 域名
- `cors.origins`：允许跨域访问的前端来源，多个放在数组中；同源本地访问不需要配置
- `security.assetSigningSecret`：图片/资产签名 URL 的 HMAC 密钥；生产环境建议配置长随机字符串，未配置时会使用进程内临时密钥
- `security.cookieSecure`：是否给 session Cookie 添加 `Secure`；`NODE_ENV=production` 时默认启用，本地 HTTP 开发可设为 `false`
- `pgy.cookie`：小红书蒲公英 Content Square Cookie header，用于“小红书热点话题”真实 Pgy 证据
- `pgy.cookieFile`：本地 cookie 文件路径，支持每行一个 JSON cookie 字典，格式兼容 `KOL/token.txt`
- `pgy.ossEndpoint`、`pgy.ossBucket`、`pgy.ossObjectKey`、`pgy.ossAccessKeyId`、`pgy.ossAccessKeySecret`：可选 OSS cookie 来源；服务端会下载 token 文件并缓存，不会向日志输出 cookie
- `pgy.allowSearchFallback`：Pgy 不可用时是否允许 `xhs` bucket 退回 AnySearch 证据，默认 `false`

管理员后台只信任 `config.local.json` 中 `admin.phones` 显式配置的手机号。未配置管理员手机号时，不会再按账号类型自动授予管理权限。

飞书企业登录使用 `/api/auth/feishu/start?app=<key>` 发起 OAuth，回调地址为 `/api/auth/feishu/callback`。服务端会根据 OAuth `state` 找回对应的 `feishu.apps[]`，用该应用的 `appSecret` 换取用户信息，再用该应用的 `tenantKeys` 校验企业身份；不再需要维护员工 open_id 白名单。

趋势分析采用“AnySearch 检索证据 → 低成本模型重排聚类 → DeepSeek V4 Flash 结构化生成”的流程，不再调用 Gemini 内置 Google Search。查询由 1 条品牌名/产品精确查询加品类、人群、趋势维度宽查询组成；网页走 `general.general`，社会话题会补充微博、知乎结果，流量、赛道和人群等适合社媒信号的维度补充知乎。服务端会去重、限制摘要、过滤私网/占位/失效 URL、划分来源级别，并要求每条趋势返回真实 `evidenceIds`。宽泛的正则相关性不再整批硬删候选：最多 30 条安全过滤后的候选交给重排模型聚成至多 10 个证据槽位（`topic/brandFit/brandLink/allowedClaims/avoidClaims`），重排失败时回退确定性评分并附 warning，不会中止生成。社媒和低可信来源只用于发现讨论方向，不能单独证明硬事实。

结果按“单条验收、结果必达”交付：非小红书维度最多 3 次逻辑模型调用（重排 1 + 主生成 1 + 单条修复 1），合格条目直接保留，只把坏条目的具体字段送去一次 targeted repair；修复后仍有问题就本地去掉无依据强断言、补齐结构并降级返回，不再因个别条目丢弃整批 10 条。成功响应的 `warnings` 数组会标注待验证/降级条目，前端以非阻断提示展示；降级成功仍按现有流程保存并扣一次积分，真正无来源时才失败且不扣积分。

`小红书热点话题` 仍优先使用蒲公英近 3 日曝光排序前 10 条帖子；Pgy 有数据时只调用一次主模型，不做业务内容否决或整批重写，模型不可解析或不足 10 条时按对应 Pgy 笔记补成完整卡片并附 warning。Pgy 默认失败即中止本次分析，避免误扣积分；显式开启 `PGY_CONTENT_SQUARE_ALLOW_SEARCH_FALLBACK` 后才会降级到 AnySearch。

## 启动

```bash
npm install # 安装依赖
npm start
```

`npm start` 只启动服务并读取已有数据库，**不会**自动更新优秀内容或调用蒲公英 `search_note_v2`。

如需手工预热默认两个优秀内容板块（小红书热门 / 电商热门），使用显式运维命令：

```bash
npm run warm:excellent-content
```

该命令会更新默认两个板块的缓存，属于人工维护流程，不会被登录、进入页面或服务启动自动触发。

健康检查：

```text
http://127.0.0.1:3013/api/health
```

页面入口：

```text
http://127.0.0.1:3013
```

## 服务器部署：固定跟随 master

生产服务器目录为 `/home/red/work/moneyboost/redbase`，固定检出并拉取 `master`。服务器使用只读部署 Key 是预期配置：只允许 `fetch/pull`，提交和推送必须在有写权限的本地开发机完成。

每次更新服务器前先确认工作区干净：

```bash
cd /home/red/work/moneyboost/redbase
git status --short
```

如果命令有输出，先停止更新并处理服务器上的本地改动。工作区干净时执行统一更新脚本（候选目录构建 → 候选目录预算检查 → 全部测试 → promote 发布 → pm2 重启 → 四路径烟测；promote 之前任何失败都不会改动 dist/public，烟测失败自动回滚到上一版本并以非零码退出）：

```bash
bash scripts/deploy-server.sh
```

等价的手工步骤（顺序不可调整，promote 之前任何一步失败都不得继续）：

```bash
git status --short          # 必须无输出
git switch master
git pull --ff-only origin master
npm ci
npm --prefix frontend ci
node scripts/build-frontend.cjs --stage-dir dist/.public-candidate-manual   # 构建候选目录，不触碰 dist/public
node scripts/check-asset-budget.cjs --dir dist/.public-candidate-manual     # 对候选目录跑预算四条规则
npm run check && npm test && npm run test:integration && npm run test:frontend
node scripts/build-frontend.cjs --promote dist/.public-candidate-manual     # 旧版本保存到 dist/.public-previous
pm2 restart redbase
curl -fsS http://127.0.0.1:3013/api/health
curl -fsS -o /dev/null http://127.0.0.1:3013/
curl -fsS -o /dev/null http://127.0.0.1:3013/app/
curl -fsS -o /dev/null http://127.0.0.1:3013/admin/
```

烟测失败时回滚到 promote 保存的备份（deploy-server.sh 会自动执行这三步并重新烟测旧版本）：

```bash
node scripts/build-frontend.cjs --rollback dist/.public-previous
pm2 restart redbase
curl -fsS http://127.0.0.1:3013/api/health   # 加上 /、/app/、/admin/ 共四路径复验
```

更新后确认服务器确实运行主干：

```bash
git branch --show-current
git log -2 --oneline
pm2 status redbase
```

日常更新只使用以下命令，不在服务器切换或部署功能分支，也不从服务器向远程仓库推送：

```bash
cd /home/red/work/moneyboost/redbase
bash scripts/deploy-server.sh
```

本地开发新功能时，先更新主干，再从主干创建功能分支。测试通过后将功能分支合入并推送 `master`，服务器随后按上述流程拉取：

```bash
git switch master
git pull --ff-only origin master
git switch -c codex/<feature-name>
```

## 校验

```bash
npm run check
npm test
npm run test:integration
npm run eval:ai
```

项目已接入风险路由验证系统。查看当前改动对应的验证计划：

```powershell
pwsh -NoProfile -File scripts/verify-change.ps1 -PlanOnly
```

Hook 与 CI 接入当前保持关闭；完成改动后由开发者主动运行验证脚本。

运行中的本地服务可以执行无依赖 API 烟测：

```bash
npm run smoke:api
```

默认烟测只覆盖健康检查、Cookie 登录、品牌 CRUD 和产品图上传/删除，不消耗 AI 额度。如果需要验证真实趋势 API：

```powershell
$env:RUN_REAL_AI = "1"
npm run smoke:api
Remove-Item Env:RUN_REAL_AI
```

可选变量：

- `SMOKE_BASE_URL`：默认 `http://127.0.0.1:3013`
- `SMOKE_PHONE` / `SMOKE_PASSWORD`：默认使用本地种子账号 `13800000000` / `123456`

## 架构说明

- 配置入口：`src/server/config.js`，真实密钥来自本机或服务器上的 `config.local.json`。
- 鉴权：`src/server/auth/cookies.js` 设置 HttpOnly Cookie；生产环境可通过 `COOKIE_SECURE`/`NODE_ENV=production` 添加 `Secure`；服务端通过 `src/server/api/sql-auth.js` 和用户/session 仓库校验登录态。
- 数据层：`src/server/db/repositories/` 提供用户、品牌、趋势、历史、产品图、图片任务和积分流水的直接 SQL 操作；`snapshot-store` 主要保留给迁移和管理后台总览兼容读取。
- AI 调用：趋势证据由 `src/server/integrations/anysearch.js` 通过 AnySearch JSON-RPC 获取，文本模型通过 RunningHub 的 OpenAI 兼容接口调用 DeepSeek；图片任务持久化到 `image_jobs` 表并在轮询时落历史生成记录。
- 静态前端：`public/app.js` 是主编排入口，公共配置、状态、DOM 工具和 API 客户端已拆到 `public/js/`。
