const { bindRouteScope } = require("./route-scope");
const { findUserBySessionToken } = require("../db/repositories/auth-repository");
const {
  getXingtuPublicVideoCatalog,
  normalizeItemId,
  requestOfficialTranscript,
  buildTranscriptLearningAnalysis,
} = require("../services/xingtu-video-service");

function findCatalogVideo(itemId) {
  const target = String(itemId || "");
  return getXingtuPublicVideoCatalog().find((item) => String(item.itemId || item.id) === target) || null;
}

function writeXingtuError(json, badRequest, res, error, fallbackMessage) {
  const status = Number(error?.statusCode) || (error?.code === "INVALID_XINGTU_ITEM_ID" ? 400 : 502);
  if (status === 400) {
    badRequest(res, error?.message || fallbackMessage);
    return;
  }
  json(res, status, {
    error: error?.message || fallbackMessage,
    code: error?.code || "XINGTU_UNAVAILABLE",
  });
}

async function handleXingtuVideoRoutes(context, req, res, pathname) {
  const {
    getSessionToken,
    buildApiUserLog,
    json,
    unauthorized,
    badRequest,
  } = bindRouteScope(context);

  function requireUser() {
    const token = getSessionToken(req);
    const user = token ? findUserBySessionToken(token) : null;
    if (!user) {
      unauthorized(res, "请先登录");
      return null;
    }
    req.__redbaseApiUser = buildApiUserLog(user);
    return user;
  }

  if (req.method === "GET" && pathname === "/api/xingtu/videos") {
    if (!requireUser()) return true;
    json(res, 200, {
      board: "xingtu",
      boardLabel: "巨量星图",
      noteType: "video",
      items: getXingtuPublicVideoCatalog(),
      updatedAt: new Date().toISOString(),
      persisted: false,
      source: {
        label: "巨量星图公开内容市场",
        url: "https://www.xingtu.cn/ad/creator/insight/content-market",
      },
    });
    return true;
  }

  const transcriptMatch = pathname.match(/^\/api\/xingtu\/videos\/([^/]+)\/transcript$/);
  if (req.method === "GET" && transcriptMatch) {
    if (!requireUser()) return true;
    try {
      const itemId = normalizeItemId(decodeURIComponent(transcriptMatch[1] || ""));
      const transcript = await requestOfficialTranscript(itemId);
      json(res, 200, transcript);
    } catch (error) {
      writeXingtuError(json, badRequest, res, error, "官方视频文稿暂时不可用。");
    }
    return true;
  }

  const learnMatch = pathname.match(/^\/api\/xingtu\/videos\/([^/]+)\/learn$/);
  if (req.method === "POST" && learnMatch) {
    if (!requireUser()) return true;
    try {
      const itemId = normalizeItemId(decodeURIComponent(learnMatch[1] || ""));
      const item = findCatalogVideo(itemId);
      if (!item) {
        json(res, 404, {
          error: "未找到该巨量星图公开视频，请返回列表重新选择。",
          code: "XINGTU_VIDEO_NOT_FOUND",
        });
        return true;
      }
      // Transcript retrieval and analysis are request-scoped only. Neither the
      // official media nor the returned text is written to disk or SQLite.
      const transcript = await requestOfficialTranscript(itemId);
      json(res, 200, {
        itemId,
        transcript: {
          available: transcript.available,
          segmentCount: transcript.segments.length,
          sourceUrl: transcript.sourceUrl,
          fetchedAt: transcript.fetchedAt,
        },
        analysis: buildTranscriptLearningAnalysis({ item, transcript }),
      });
    } catch (error) {
      writeXingtuError(json, badRequest, res, error, "巨量星图视频学习分析暂时不可用。");
    }
    return true;
  }

  return false;
}

module.exports = {
  handleXingtuVideoRoutes,
};
