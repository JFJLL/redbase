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

生产和本地运行都优先使用环境变量，不要把真实 API Key 写入仓库文件。

PowerShell 示例：

```powershell
$env:TEXT_API_STYLE = "google"
$env:TEXT_MODEL = "gemini-3.1-flash-lite-preview"
$env:TEXT_BASE_URL = "https://api.im-red-magic.cn"
$env:TEXT_API_KEY = "<your-text-api-key>"
$env:IMAGE_API_KEY = "<your-image-api-key>"
$env:ADMIN_PHONES = "13800000000"
$env:ASSET_SIGNING_SECRET = "<long-random-string>"
$env:COOKIE_SECURE = "false"
npm start
```

常用环境变量：

- `TEXT_API_STYLE`：文本模型接口类型，默认 `google`
- `TEXT_MODEL`：文本模型名，默认 `gemini-3.1-flash-lite-preview`
- `TEXT_BASE_URL`：Google 风格文本接口地址
- `TEXT_OPENAI_BASE_URL`：OpenAI 兼容接口地址
- `TEXT_ANTHROPIC_BASE_URL`：Anthropic 兼容接口地址
- `TEXT_API_KEY`：文本模型 API Key
- `TEXT_SEARCH_ENABLED`：是否启用搜索，默认 `true`
- `IMAGE_BASE_URL`：图片生成接口地址
- `IMAGE_EDIT_BASE_URL`：图片编辑接口地址
- `IMAGE_UPLOAD_BASE_URL`：图片上传接口地址
- `IMAGE_MODEL`：图片模型名，默认 `gpt-image-2`
- `IMAGE_API_KEY`：图片模型 API Key
- `IMAGE_ASPECT_RATIO`、`IMAGE_RESOLUTION`、`IMAGE_QUALITY`、`IMAGE_COUNT`：图片参数
- `ADMIN_PHONES`：管理员手机号，多个用英文逗号分隔
- `CORS_ORIGINS`：允许跨域访问的前端来源，多个用英文逗号分隔；同源本地访问不需要配置
- `ASSET_SIGNING_SECRET`：图片/资产签名 URL 的 HMAC 密钥；生产环境建议配置长随机字符串，未配置时会使用进程内临时密钥
- `COOKIE_SECURE`：是否给 session Cookie 添加 `Secure`；`NODE_ENV=production` 时默认启用，本地 HTTP 开发可设为 `false`
- `PGY_CONTENT_SQUARE_COOKIE`：小红书蒲公英 Content Square Cookie header，用于“小红书热点话题”真实 Pgy 证据
- `PGY_COOKIE_FILE` / `PGY_CONTENT_SQUARE_COOKIE_FILE`：本地 cookie 文件路径，支持每行一个 JSON cookie 字典，格式兼容 `KOL/token.txt`
- `PGY_OSS_ENDPOINT`、`PGY_OSS_BUCKET`、`PGY_OSS_OBJECT_KEY`、`PGY_OSS_ACCESS_KEY_ID`、`PGY_OSS_ACCESS_KEY_SECRET`：可选 OSS cookie 来源；服务端会下载 token 文件并缓存，不会向日志输出 cookie
- `PGY_CONTENT_SQUARE_ALLOW_SEARCH_FALLBACK`：Pgy 不可用时是否允许 `xhs` bucket 退回原搜索流程，默认 `false`

管理员后台只信任 `ADMIN_PHONES` / `config.local.json` 中显式配置的手机号。未配置管理员手机号时，不会再按账号类型自动授予管理权限。

趋势分析保持单次搜索增强文本模型调用；配置 Pgy 后，`小红书热点话题` 会拉取蒲公英近 3 日曝光排序前 10 条帖子作为证据，并由文本模型总结趋势、品牌关联和每条趋势下的 2 个选题，其余趋势 bucket 继续使用搜索增强。Pgy 默认失败即中止本次分析，避免误扣积分；如需临时回退，可显式开启 `PGY_CONTENT_SQUARE_ALLOW_SEARCH_FALLBACK`。

## 启动

```bash
npm install # 安装依赖
npm start
```

健康检查：

```text
http://127.0.0.1:3013/api/health
```

页面入口：

```text
http://127.0.0.1:3013
```

## 校验

```bash
npm run check
```

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

- 配置入口：`src/server/config.js`，真实密钥优先来自环境变量。
- 鉴权：`src/server/auth/cookies.js` 设置 HttpOnly Cookie；生产环境可通过 `COOKIE_SECURE`/`NODE_ENV=production` 添加 `Secure`；服务端通过 `src/server/api/sql-auth.js` 和用户/session 仓库校验登录态。
- 数据层：`src/server/db/repositories/` 提供用户、品牌、趋势、历史、产品图、图片任务和积分流水的直接 SQL 操作；`snapshot-store` 主要保留给迁移和管理后台总览兼容读取。
- AI 调用：文本模型走 Node 原生 `fetch`，图片任务持久化到 `image_jobs` 表并在轮询时落历史生成记录。
- 静态前端：`public/app.js` 是主编排入口，公共配置、状态、DOM 工具和 API 客户端已拆到 `public/js/`。
