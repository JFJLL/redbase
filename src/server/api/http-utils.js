const { getCookieSessionToken } = require("../auth/cookies");

const MAX_REQUEST_BODY_BYTES = 45 * 1024 * 1024;
async function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      if (tooLarge) return;

      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error("请求体过大，请压缩图片或上传更小的文件。"), { code: "PAYLOAD_TOO_LARGE" }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks, totalBytes).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function getSessionToken(req) {
  const cookieToken = getCookieSessionToken(req);
  if (cookieToken) return cookieToken;
  const headerToken = req.headers["x-session-token"];
  if (headerToken) return headerToken;
  return "";
}

function shouldLogApiRequest(pathname) {
  if (!String(pathname || "").startsWith("/api/")) return false;
  return pathname !== "/api/health";
}

function installApiRequestLogger(req, res, pathname) {
  if (req.__redbaseApiLoggerInstalled) return;
  req.__redbaseApiLoggerInstalled = true;
  const startedAt = Date.now();
  res.once("finish", () => {
    const statusCode = res.statusCode || 0;
    const payload = {
      method: req.method,
      path: pathname,
      statusCode,
      durationMs: Date.now() - startedAt,
      user: req.__redbaseApiUser || null,
      request: buildApiRequestLog(req),
    };
    if (statusCode >= 500) {
      console.error("[api] request completed", payload);
    } else if (statusCode >= 400) {
      console.warn("[api] request completed", payload);
    } else {
      console.log("[api] request completed", payload);
    }
  });
}

function buildApiRequestLog(req) {
  const queryKeys = [];
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    for (const key of url.searchParams.keys()) {
      if (!["token", "password", "code", "sessionToken", "assetSignature"].includes(key)) {
        queryKeys.push(key);
      }
    }
  } catch (error) {
    // Ignore malformed URLs in logging.
  }
  return {
    contentLength: req.headers["content-length"] || "",
    queryKeys: [...new Set(queryKeys)],
    ip: getRequestIp(req),
    userAgent: truncateLogString(req.headers["user-agent"] || "", 180),
  };
}

function getRequestIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwardedFor || req.socket?.remoteAddress || "";
}

function buildApiUserLog(user) {
  return {
    id: user.id,
    phone: maskPhone(user.phone),
    accountType: user.accountType || "customer",
  };
}

function maskPhone(phone) {
  const text = String(phone || "");
  if (text.length < 7) return text ? "***" : "";
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

function truncateLogString(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function formatImageServiceError(error) {
  const message = String(error?.message || "图片服务暂时不可用");
  if (
    message.includes("fetch failed") ||
    message.includes("ENOTFOUND") ||
    message.includes("ECONNRESET") ||
    message.includes("timeout") ||
    message.includes("Client network socket disconnected")
  ) {
    return "图片服务连接失败，请稍后重试；如果连续失败，请检查服务器到已配置图片接口的网络连接。";
  }
  return message;
}

function unauthorized(res, message = "Unauthorized") {
  json(res, 401, { error: message });
}

function forbidden(res, message = "Forbidden") {
  json(res, 403, { error: message });
}

module.exports = {
  MAX_REQUEST_BODY_BYTES,
  collectBody,
  getSessionToken,
  shouldLogApiRequest,
  installApiRequestLogger,
  buildApiRequestLog,
  getRequestIp,
  buildApiUserLog,
  maskPhone,
  truncateLogString,
  json,
  notFound,
  badRequest,
  formatImageServiceError,
  unauthorized,
  forbidden,
};
