# RedBase

小红书内容运营工具，本地运行版本。

## 当前状态

- 不再内置预置品牌或趋势演示数据
- 趋势分析与选题改写走真实文本模型
- 一键生图走真实图片服务
- 数据持久化到 `data/redbase.sqlite`
- 后端已拆到 `src/server/*`

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

趋势分析默认会先尝试 `google_search`，失败时自动降级为纯模型生成，避免主流程卡死。

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
