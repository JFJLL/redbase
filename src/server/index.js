const http = require("http");
const { HOST, PORT, loadAppConfig } = require("./config");
const { ensureStore, readStore, writeStore } = require("./store");
const { createAiServices } = require("./ai");
const { createApiHandler, json } = require("./api");
const { serveStatic } = require("./static");

async function start() {
  const appConfig = loadAppConfig();
  const store = { ensureStore, readStore, writeStore };
  const ai = createAiServices(appConfig);
  const handleApi = createApiHandler({ appConfig, store, ai });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
      const handled = await handleApi(req, res, url.pathname);
      if (handled) return;
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      console.error(error);
      if (error?.code === "PAYLOAD_TOO_LARGE") {
        json(res, 413, { error: error.message });
        return;
      }
      if (error?.code === "IMAGE_LIMIT_EXCEEDED") {
        json(res, 400, { error: error.message });
        return;
      }
      json(res, 500, { error: String(error.message || "Internal server error") });
    }
  });

  await ensureStore();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });

  console.log(`Server running at http://${HOST}:${PORT}`);
  return server;
}

module.exports = {
  start,
};
