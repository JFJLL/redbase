const { createLocalGeneratedAssetStorage } = require("./local-generated-asset-storage");
const { createAliyunOssGeneratedAssetStorage } = require("./aliyun-oss-generated-asset-storage");
const { inferGeneratedAssetProvider } = require("./generated-asset-utils");

function createGeneratedAssetStorage(appConfig = {}, dependencies = {}) {
  const local = createLocalGeneratedAssetStorage(dependencies.local || dependencies);
  const configuredProvider = appConfig?.assetStorage?.provider === "aliyun_oss" ? "aliyun_oss" : "local";
  const aliyunOss = configuredProvider === "aliyun_oss"
    ? createAliyunOssGeneratedAssetStorage(appConfig.assetStorage.aliyunOss, dependencies.aliyunOss || dependencies)
    : null;
  const selected = aliyunOss || local;

  function backendFor(asset) {
    return inferGeneratedAssetProvider(asset) === "aliyun_oss" ? aliyunOss : local;
  }

  return {
    provider: selected.provider,
    isConfigured: () => selected.isConfigured(),
    save: (input) => selected.save(input),
    async delete(asset) {
      const backend = backendFor(asset);
      if (!backend) throw new Error("Aliyun OSS generated asset storage is not configured");
      return backend.delete(asset);
    },
    async deleteMany(assets = []) {
      const ossAssets = assets.filter((asset) => inferGeneratedAssetProvider(asset) === "aliyun_oss");
      const localAssets = assets.filter((asset) => inferGeneratedAssetProvider(asset) === "local");
      const results = [];
      if (ossAssets.length) {
        if (!aliyunOss) throw new Error("Aliyun OSS generated asset storage is not configured");
        results.push(...await aliyunOss.deleteMany(ossAssets));
      }
      if (localAssets.length) results.push(...await local.deleteMany(localAssets));
      return results;
    },
    async createReadUrl(asset, options) {
      const backend = backendFor(asset);
      if (!backend) throw new Error("Aliyun OSS generated asset storage is not configured");
      return backend.createReadUrl(asset, options);
    },
    async readBuffer(asset) {
      const backend = backendFor(asset);
      if (!backend) throw new Error("Aliyun OSS generated asset storage is not configured");
      return backend.readBuffer(asset);
    },
  };
}

module.exports = {
  createGeneratedAssetStorage,
};
