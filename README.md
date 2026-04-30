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
├─ config.local.example.json
├─ package.json
└─ server.js          启动入口
```

## 模型配置

复制 `config.local.example.json` 为 `config.local.json`，填写：

- `textProvider.apiKey`
- `imageProvider.apiKey`

默认文本模型：

- `apiStyle: google`
- `baseUrl: https://api.im-red-magic.cn`
- `model: gemini-3.1-flash-lite-preview`

趋势分析默认会先尝试 `google_search`，失败时自动降级为纯模型生成，避免主流程卡死。

默认图片模型：

- `baseUrl: https://api.wavespeed.ai/api/v3/openai/gpt-image-2/text-to-image`
- `model: gpt-image-2`

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
