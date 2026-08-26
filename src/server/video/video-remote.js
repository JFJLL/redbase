const net = require("net");

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/[\[\]]/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (net.isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);
  }
  if (net.isIP(host) === 6) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89a-f]/.test(host);
  return false;
}

function isAllowedProviderHost(url, allowedHosts = []) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (isPrivateHostname(hostname)) return false;
  const hosts = allowedHosts.map((item) => String(item || "").toLowerCase().replace(/^\.+/, "")).filter(Boolean);
  if (!hosts.length) return false;
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function assertSafeProviderUrl(value, { allowedHosts = [] } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch (_error) {
    throw new Error("供应商返回的媒体地址无效");
  }
  if (parsed.protocol !== "https:") throw new Error("供应商媒体地址必须使用 HTTPS");
  if (!isAllowedProviderHost(parsed.toString(), allowedHosts)) throw new Error("供应商媒体地址 host 未通过安全校验");
  return parsed;
}

async function readResponseWithLimit(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (contentLength > maxBytes) throw Object.assign(new Error("供应商媒体超过大小限制"), { code: "PAYLOAD_TOO_LARGE" });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw Object.assign(new Error("供应商媒体超过大小限制"), { code: "PAYLOAD_TOO_LARGE" });
  return buffer;
}

async function downloadProviderMedia(url, { allowedHosts = [], maxBytes = 60 * 1024 * 1024, timeoutMs = 30000, fetchImpl = fetch, expected = "video" } = {}) {
  let nextUrl = String(url || "");
  for (let redirect = 0; redirect <= 2; redirect += 1) {
    const parsed = assertSafeProviderUrl(nextUrl, { allowedHosts });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(parsed, { redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.get?.("location");
      if (!location) throw new Error("供应商重定向缺少 Location");
      nextUrl = new URL(location, parsed).toString();
      continue;
    }
    if (!response.ok) throw new Error(`供应商媒体下载失败：HTTP ${response.status}`);
    const contentType = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (expected === "video" && contentType && contentType !== "video/mp4" && !contentType.startsWith("video/")) {
      throw new Error("供应商响应不是 MP4 视频");
    }
    if (expected === "image" && contentType && !contentType.startsWith("image/")) {
      throw new Error("供应商响应不是图片");
    }
    const buffer = await readResponseWithLimit(response, maxBytes);
    return { buffer, contentType: contentType || (expected === "video" ? "video/mp4" : "image/jpeg"), url: parsed.toString() };
  }
  throw new Error("供应商媒体重定向次数过多");
}

module.exports = {
  isPrivateHostname,
  isAllowedProviderHost,
  assertSafeProviderUrl,
  downloadProviderMedia,
};
