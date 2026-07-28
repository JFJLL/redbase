/**
 * StorageProvider 预留接口（为未来 OSS 接入留的缝）。
 *
 * 本阶段只有 local 驱动：参考图片 URL 直接透传给多模态模型，
 * 不下载图片、不保存图片文件、不生成 CDN 永久地址。
 * 未来接入 OSS 时新增 aliyun 驱动，把参考图转存后返回可控地址，
 * 调用方（excellent-content-vision-service）无需改动。
 */
const STORAGE_DRIVERS = Object.freeze({
  LOCAL: "local",
  // 未来：ALIYUN: "aliyun"
});

function createExcellentVisionStorageProvider({ driver = STORAGE_DRIVERS.LOCAL } = {}) {
  if (driver !== STORAGE_DRIVERS.LOCAL) {
    const error = new Error(`暂不支持的存储驱动：${driver}`);
    error.code = "STORAGE_DRIVER_UNSUPPORTED";
    throw error;
  }
  return {
    driver,
    /**
     * 把参考图片来源解析为模型可用的输入描述。
     * local 驱动：只透传 http(s) URL，本阶段不做任何图片持久化。
     */
    async resolveImageInputs(imageUrls) {
      return (Array.isArray(imageUrls) ? imageUrls : [])
        .map((url) => String(url || "").trim())
        .filter((url) => /^https?:\/\//i.test(url))
        .map((url) => ({ type: "url", url }));
    },
  };
}

module.exports = {
  STORAGE_DRIVERS,
  createExcellentVisionStorageProvider,
};
