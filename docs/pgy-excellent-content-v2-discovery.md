# Pgy Excellent Content V2 — API Discovery (Desensitized)

**验证日期**: 2026-07-23  
**页面**: `https://pgy.xiaohongshu.com/microapp/creativity/inspire`  
**方法**: Kimi WebBridge + Tabbit 已登录会话；Network/XHR 抓取 + 页面内 `fetch` 对照探针  
**禁止写入本报告**: Cookie / Token / Authorization / web_session / 手机号 / 完整上游响应

---

## 1. 小红书热门

| 项 | 真实值 |
|---|---|
| endpoint | `POST https://edith.xiaohongshu.com/api/pgy/content_square/search_note_v2` |
| method | `POST` |
| bizType | `"1"` |
| orderBy（阅读量） | `premium_read_num` |
| orderBy（默认曝光量） | `premium_imp_num` |
| nd（近7日） | `"7"` |
| noteType（图文） | `1` 或 `"1"`（页面发送字符串） |
| 类目字段 | `noteContentCategory` |
| 类目路径格式 | `内容类目#一级` 或 `内容类目#一级#二级`（短路径 `美妆` 在探针中也可用） |
| 内容来源字段 | `contentType`（整数；全部时页面可发 `"-1"`） |
| pagination | `pageNum`（从 1）、`pageSize`（页面默认 34；服务端可用 20） |
| 其它固定 | `platform: 1`, `sort: "desc"`, `searchWord: ""` |

页面筛选项（该板块）：**类目 / 内容类型 / 内容来源 / 排序 / 近7日**

---

## 2. 电商热门

| 项 | 真实值 |
|---|---|
| endpoint | **同一** `POST .../search_note_v2` |
| method | `POST` |
| bizType | `"6"`（浏览器切换板块后的真实请求体） |
| orderBy（阅读量） | `premium_read_num`（与小红书热门相同） |
| nd（近7日） | `"7"` |
| noteType（图文） | `1` / `"1"` |
| 所属行业字段 | **仍使用** `noteContentCategory`（不是独立 industry 字段名） |
| 行业路径格式 | `所属行业#一级` 或 `所属行业#一级#二级` |
| 内容来源字段 | `contentType`（与小红书热门相同） |
| pagination | 同小红书热门 |

页面筛选项（该板块）：**所属行业 / 内容类型 / 内容来源 / 排序 / 近7日**

说明：`bizType=2/3/4/5` 接口也返回 200，但 **真实 UI 切换「电商热门」发送的是 `bizType:"6"`**，以 UI 为准。

---

## 3. 内容来源选项映射

请求字段：`contentType`（整型；字符串数字亦可）。

| 页面文案（既有实现 + UI 可见「用户笔记」） | 本地 value | contentType |
|---|---|---|
| 全部 | `all` / 空 | 不传，或 `"-1"` / `-1`（页面行为） |
| 博主合作笔记 | `kol` | `1` |
| 明星合作笔记 | `celebrity` | `2` |
| 员工笔记 | `employee` | `3` |
| 买手笔记 | `buyer` | `5` |
| 专业号笔记 | `professional` | `6` |
| 主理人笔记 | `owner` | `11` |
| 用户笔记 | `user` | `12` |

两板块共用同一 `contentType` 枚举。  
探针确认不同 `contentType` 返回的 top noteId 不同；`contentType` 非整数（如 `"professional"`）返回 400。

**RedBase 默认**: 全部内容来源（不传 `contentType`，与「全量小红书热门」兼容；旧缓存 `source_key=xhs_hot` 保留）。

---

## 4. 小红书内容类目树接口

```
GET https://edith.xiaohongshu.com/api/pgy/content_square/attribute/item/detail?type=tree&itemKey=noteContentCategory&platform=1
```

响应 `data` 为数组，包含两个根节点：

1. **内容类目** (`itemValue: "内容类目"`) — 约 28 个一级（美妆、护肤、个人护理、母婴、时尚…）
2. **所属行业** (`itemValue: "所属行业"`) — 约 25 个一级（母婴、家用电器、3C数码、食品饮料、美妆个护…）

子节点字段：`label` / `itemName`、`itemValue`、`children`。

小红书热门只使用「内容类目」子树。

---

## 5. 电商所属行业树接口

**同一树接口**，取根节点「所属行业」。

禁止把「内容类目」子树当行业用，也禁止只改文案共用一份树。

路径请求示例（已探针验证会改变结果集）：

- `noteContentCategory: "所属行业#美妆个护"`
- `noteContentCategory: "所属行业#美妆个护#彩妆"`

短路径无前缀（如 `美妆个护`）在电商 bizType=6 下 total=0，**必须带 `所属行业#` 前缀**。

---

## 6. 笔记详情接口

- 列表项字段含：`noteInfo.noteImages[]`、`title`、`readNum`、`likeNum`、`favNum`、`cmtNum`、`notePublishTime`、`noteLink`、`noteId`、`noteType` 等。
- **列表响应中未见正文**（无 `noteDesc` / `desc` / `content` / `text`）。
- 候选详情 URL（`/note/detail` 等）在页面上下文 `fetch` 失败（CORS/不存在），**未确认到可用独立详情上游**。
- **结论**: 以列表缓存中的完整 `noteImages` 作为图集来源；正文未知时返回空字符串，不伪造；不抓 HTML/OCR。

---

## 7. 图片字段

`noteInfo.noteImages[]` 元素：

- `imageUrl`
- `imageWidth`
- `imageHeight`

列表已可返回多图（探针见 1～15 张），**一般足够做左右切换图集**；`imageCount` 字段在样本中未出现，以 `noteImages.length` 为准。

---

## 8. 正文字段

列表 **无正文**。详情上游未确认。产品侧 `content` 允许为空字符串。

---

## 9. 仍不确定 / 限制

1. 内容来源完整 UI 文案与 `contentType` 的一一对应主要依据既有 38121be 映射 + 探针差异确认；本轮 UI 下拉抓取有噪声，但 `contentType` 枚举有效。
2. 独立 note 详情上游未接通；正文可能长期为空。
3. 页面默认 `pageSize=34`；服务端用 20×3 页足够凑 TOP8 图文。
4. 列表 `noteType`: `1`=图文，`2`=视频。

---

## 10. 与方案候选差异

| 方案候选 | 真实结果 |
|---|---|
| `premium_read_num` | ✅ 确认 |
| `ECOMMERCE_HOT` bizType | ❌ 非法；真实为 `"6"` |
| 小红书热门 bizType `1` | ✅ 确认 |
| 行业独立字段名 | ❌ 共用 `noteContentCategory`，前缀 `所属行业#` |
| 列表仅封面 | ❌ 列表常含完整图集，无正文 |

---

## 11. 优秀内容固定请求口径（实现用）

```
orderBy: premium_read_num
nd: "7"
noteType: 1
sort: desc
pageSize: 20
maxPages: 3
limit: 8
```

- 小红书热门: `bizType: "1"` + 可选 `noteContentCategory: 内容类目#...` + 可选 `contentType`
- 电商热门: `bizType: "6"` + 可选 `noteContentCategory: 所属行业#...` + 可选 `contentType`

趋势分析默认保持：`bizType "1"`, `orderBy premium_imp_num`, `nd "3"`, 不强制 noteType / contentType。
