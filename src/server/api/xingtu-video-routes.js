const { Readable } = require("stream");
const { bindRouteScope } = require("./route-scope");
const { findUserBySessionToken } = require("../db/repositories/auth-repository");
const {
  getXingtuPublicVideoCatalog,
  getXingtuVideoMediaSource,
  normalizeItemId,
  requestOfficialCover,
  requestOfficialMedia,
  buildXingtuPreviewCover,
  requestOfficialTranscript,
  buildTranscriptLearningAnalysis,
} = require("../services/xingtu-video-service");

function findCatalogVideo(itemId) {
  const target = String(itemId || "");
  return getXingtuPublicVideoCatalog().find((item) => String(item.itemId || item.id) === target) || null;
}

function findVideoMediaSource(itemId) {
  try {
    return getXingtuVideoMediaSource(itemId);
  } catch (_error) {
    return null;
  }
}

function sendXingtuPreviewCover(res, item) {
  const body = Buffer.from(buildXingtuPreviewCover(item), "utf8");
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "content-length": body.length,
    "cache-control": "public, max-age=3600",
  });
  res.end(body);
}

function sendOfficialResource(res, response) {
  const headers = {};
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  headers["cache-control"] = headers["cache-control"] || "private, max-age=300";
  res.writeHead(response.status === 206 ? 206 : 200, headers);
  if (!response.body) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body)
    .on("error", () => res.destroy())
    .pipe(res);
}

function parseXingtuFilters(req) {
  const query = new URL(req.url || "/", "http://localhost").searchParams;
  const videoType = String(query.get("videoType") || "all").trim();
  const contentType = String(query.get("contentType") || "all").trim();
  const dataSort = String(query.get("dataSort") || "all").trim();
  return {
    videoType: ["all", "星图视频", "自然视频"].includes(videoType) ? videoType : "all",
    contentType: contentType || "all",
    dataSort: ["all", "likeCount", "commentCount", "shareCount", "interactCount", "followerCount"].includes(dataSort) ? dataSort : "all",
  };
}

function filterXingtuCatalog(items, filters) {
  const filtered = (items || []).filter((item) => {
    if (filters.videoType !== "all" && String(item.videoType || "") !== filters.videoType) return false;
    if (filters.contentType !== "all" && String(item.category || "") !== filters.contentType) return false;
    return true;
  });
  if (filters.dataSort === "all") return filtered;
  return [...filtered].sort((left, right) => {
    const leftValue = filters.dataSort === "followerCount" ? Number(left.author?.followerCount || 0) : Number(left.metrics?.[filters.dataSort] || 0);
    const rightValue = filters.dataSort === "followerCount" ? Number(right.author?.followerCount || 0) : Number(right.metrics?.[filters.dataSort] || 0);
    return rightValue - leftValue;
  });
}

function unavailableTranscript(itemId) {
  return {
    itemId,
    available: false,
    segments: [],
    unavailableReason: "当前未获取到视频文稿。",
  };
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

  const xingtuRequestOptions = {
    cookie: String(context.appConfig?.xingtu?.cookie || ""),
    cookieFile: String(context.appConfig?.xingtu?.cookieFile || ""),
  };

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
      items: filterXingtuCatalog(getXingtuPublicVideoCatalog(), parseXingtuFilters(req)),
      filters: parseXingtuFilters(req),
      updatedAt: new Date().toISOString(),
      persisted: false,
    });
    return true;
  }

  const coverMatch = pathname.match(/^\/api\/xingtu\/videos\/([^/]+)\/cover$/);
  if (req.method === "GET" && coverMatch) {
    const item = findVideoMediaSource(decodeURIComponent(coverMatch[1] || "")) || findCatalogVideo(decodeURIComponent(coverMatch[1] || ""));
    if (!item) {
      json(res, 404, { error: "未找到该视频封面。", code: "XINGTU_VIDEO_NOT_FOUND" });
      return true;
    }
    try {
      sendOfficialResource(res, await requestOfficialCover(item, xingtuRequestOptions));
    } catch (_error) {
      sendXingtuPreviewCover(res, item);
    }
    return true;
  }

  const mediaMatch = pathname.match(/^\/api\/xingtu\/videos\/([^/]+)\/media$/);
  if (req.method === "GET" && mediaMatch) {
    const item = findVideoMediaSource(decodeURIComponent(mediaMatch[1] || "")) || findCatalogVideo(decodeURIComponent(mediaMatch[1] || ""));
    if (!item) {
      json(res, 404, { error: "未找到该视频。", code: "XINGTU_VIDEO_NOT_FOUND" });
      return true;
    }
    try {
      sendOfficialResource(res, await requestOfficialMedia(item, { ...xingtuRequestOptions, range: req.headers.range || "" }));
    } catch (error) {
      writeXingtuError(json, badRequest, res, error, "视频暂时无法播放。");
    }
    return true;
  }

  const transcriptMatch = pathname.match(/^\/api\/xingtu\/videos\/([^/]+)\/transcript$/);
  if (req.method === "GET" && transcriptMatch) {
    if (!requireUser()) return true;
    try {
      const itemId = normalizeItemId(decodeURIComponent(transcriptMatch[1] || ""));
      const transcript = await requestOfficialTranscript(itemId, xingtuRequestOptions);
      json(res, 200, transcript);
    } catch (_error) {
      json(res, 200, unavailableTranscript(normalizeItemId(decodeURIComponent(transcriptMatch[1] || ""))));
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
      let transcript;
      let unavailableReason = "";
      try {
        transcript = await requestOfficialTranscript(itemId, xingtuRequestOptions);
      } catch (_error) {
        transcript = unavailableTranscript(itemId);
        unavailableReason = transcript.unavailableReason;
      }
      json(res, 200, {
        itemId,
        transcript: {
          available: transcript.available,
          segmentCount: transcript.segments.length,
          unavailableReason,
          sourceUrl: transcript.sourceUrl,
          fetchedAt: transcript.fetchedAt,
        },
        analysis: buildTranscriptLearningAnalysis({ item, transcript }),
      });
    } catch (error) {
      writeXingtuError(json, badRequest, res, error, "视频学习分析暂时不可用。");
    }
    return true;
  }

  return false;
}

module.exports = {
  handleXingtuVideoRoutes,
};
