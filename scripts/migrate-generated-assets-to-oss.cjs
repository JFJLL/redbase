#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

const MIME_BY_EXTENSION = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
});

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    projectDir: path.resolve(__dirname, ".."),
    backupDir: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--project-dir") options.projectDir = path.resolve(argv[++index] || "");
    else if (arg === "--backup-dir") options.backupDir = path.resolve(argv[++index] || "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.projectDir || options.projectDir === path.parse(options.projectDir).root) {
    throw new Error("A valid --project-dir is required");
  }
  if (!options.backupDir) options.backupDir = path.join(options.projectDir, "outputs", "migration-backups");
  return options;
}

function inferMimeType(asset) {
  const explicit = String(asset?.mimeType || "").trim().toLowerCase();
  if (explicit) return explicit;
  return MIME_BY_EXTENSION[path.extname(String(asset?.storedPath || "")).toLowerCase()] || "";
}

function inferVariant(asset, generationId) {
  const explicit = String(asset?.variant || "").trim();
  if (explicit) return explicit;
  const filename = path.basename(String(asset?.storedPath || ""));
  const prefix = `gi_${Number(generationId)}_`;
  if (!filename.startsWith(prefix)) return "";
  const withoutExtension = filename.slice(prefix.length, filename.length - path.extname(filename).length);
  const randomSeparator = withoutExtension.lastIndexOf("_");
  return randomSeparator > 0 ? withoutExtension.slice(0, randomSeparator) : "";
}

function replaceLocalAssets(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => replaceLocalAssets(item, replacements));
  if (!value || typeof value !== "object") return value;
  const storedPath = typeof value.storedPath === "string" ? value.storedPath : "";
  const uploaded = storedPath ? replacements.get(storedPath) : null;
  if (uploaded) {
    return {
      ...value,
      ...uploaded,
      provider: "aliyun_oss",
      storedPath: "",
      createdAt: value.createdAt || uploaded.createdAt,
      variant: value.variant || uploaded.variant,
      mimeType: value.mimeType || uploaded.mimeType,
      sizeBytes: Number(value.sizeBytes || uploaded.sizeBytes || 0),
    };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceLocalAssets(child, replacements)]));
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function loadProjectModules(projectDir) {
  const fromProject = (relativePath) => require(path.join(projectDir, relativePath));
  return {
    ...fromProject("src/server/config.js"),
    ...fromProject("src/server/store.js"),
    ...fromProject("src/server/db/connection.js"),
    ...fromProject("src/server/db/repositories/generation-repository.js"),
    ...fromProject("src/server/assets/generated-asset-storage.js"),
    ...fromProject("src/server/assets/local-generated-asset-storage.js"),
    ...fromProject("src/server/assets/generation-deletion-service.js"),
  };
}

async function buildMigrationPlan(modules) {
  const generations = modules.listAllGenerations();
  const plans = [];
  let totalBytes = 0;
  let missingAssets = 0;
  for (const generation of generations) {
    const assets = modules.collectGenerationAssets(generation).filter((asset) => asset.provider === "local");
    if (!assets.length) continue;
    const plannedAssets = [];
    for (const asset of assets) {
      modules.assertGenerationAssetOwnership(asset, generation);
      const filePath = modules.resolveLocalAssetPath(asset.storedPath);
      let stat = null;
      try {
        stat = await fs.stat(filePath);
        totalBytes += Number(stat.size || 0);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        missingAssets += 1;
      }
      plannedAssets.push({
        asset,
        filePath,
        sizeBytes: Number(stat?.size || 0),
        exists: Boolean(stat?.isFile()),
        mimeType: inferMimeType(asset),
        variant: inferVariant(asset, generation.id),
      });
    }
    plans.push({ generation, assets: plannedAssets });
  }
  return {
    generationsScanned: generations.length,
    plans,
    localAssetCount: plans.reduce((sum, plan) => sum + plan.assets.length, 0),
    totalBytes,
    missingAssets,
  };
}

async function migrateGeneration(plan, context) {
  const { storage, db } = context;
  const row = db.prepare("SELECT payload_json, updated_at FROM generations WHERE id = ?").get(Number(plan.generation.id));
  if (!row) throw new Error(`Generation ${plan.generation.id} no longer exists`);
  if (row.payload_json !== JSON.stringify(plan.generation.payload || {})) {
    throw new Error(`Generation ${plan.generation.id} changed after planning; rerun the migration`);
  }
  const missing = plan.assets.filter((entry) => !entry.exists);
  if (missing.length) throw new Error(`Generation ${plan.generation.id} has ${missing.length} missing local asset(s)`);

  const uploadedAssets = [];
  const replacements = new Map();
  let nextPayloadJson = "";
  let databaseUpdated = false;
  try {
    for (const entry of plan.assets) {
      if (!entry.mimeType) throw new Error(`Cannot infer MIME type for generation ${plan.generation.id}`);
      if (!entry.variant) throw new Error(`Cannot infer asset variant for generation ${plan.generation.id}`);
      const uploaded = await storage.saveFile({
        filePath: entry.filePath,
        ownerUserId: plan.generation.ownerUserId,
        generationId: plan.generation.id,
        variant: entry.variant,
        mimeType: entry.mimeType,
      });
      const remoteStat = await storage.stat(uploaded);
      if (Number(remoteStat?.size || 0) !== entry.sizeBytes) {
        throw new Error(`OSS size verification failed for generation ${plan.generation.id}`);
      }
      uploadedAssets.push(uploaded);
      replacements.set(entry.asset.storedPath, uploaded);
    }

    const nextPayload = replaceLocalAssets(plan.generation.payload || {}, replacements);
    nextPayloadJson = JSON.stringify(nextPayload);
    const updatedAt = new Date().toISOString();
    const result = db.prepare(`
      UPDATE generations
      SET payload_json = ?, updated_at = ?
      WHERE id = ? AND payload_json = ?
    `).run(nextPayloadJson, updatedAt, Number(plan.generation.id), row.payload_json);
    if (result.changes !== 1) throw new Error(`Generation ${plan.generation.id} changed during migration`);
    databaseUpdated = true;

    const verifiedRow = db.prepare("SELECT payload_json FROM generations WHERE id = ?").get(Number(plan.generation.id));
    const verifiedPayload = JSON.parse(verifiedRow?.payload_json || "{}");
    const remainingLocal = modulesForVerification.collectGenerationAssets({ ...plan.generation, payload: verifiedPayload })
      .filter((asset) => asset.provider === "local");
    if (remainingLocal.length) throw new Error(`Generation ${plan.generation.id} still has local asset references`);
    return { migratedAssets: uploadedAssets.length, migratedBytes: plan.assets.reduce((sum, entry) => sum + entry.sizeBytes, 0) };
  } catch (error) {
    if (databaseUpdated) {
      db.prepare("UPDATE generations SET payload_json = ?, updated_at = ? WHERE id = ? AND payload_json = ?")
        .run(row.payload_json, row.updated_at, Number(plan.generation.id), nextPayloadJson);
    }
    if (uploadedAssets.length) await storage.deleteMany(uploadedAssets).catch(() => {});
    throw error;
  }
}

let modulesForVerification = null;

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const modules = loadProjectModules(options.projectDir);
  modulesForVerification = modules;
  await modules.ensureStore();
  const appConfig = modules.loadAppConfig();
  if (appConfig?.assetStorage?.provider !== "aliyun_oss") {
    throw new Error("assetStorage.provider must be aliyun_oss before migration");
  }
  const storage = modules.createGeneratedAssetStorage(appConfig);
  if (storage.provider !== "aliyun_oss" || !storage.isConfigured()) {
    throw new Error("Aliyun OSS generated asset storage is not configured");
  }

  const plan = await buildMigrationPlan(modules);
  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    provider: storage.provider,
    generationsScanned: plan.generationsScanned,
    generationsWithLocalAssets: plan.plans.length,
    localAssetCount: plan.localAssetCount,
    totalBytes: plan.totalBytes,
    missingAssets: plan.missingAssets,
  };
  if (!options.apply) {
    console.log(JSON.stringify(summary));
    return summary;
  }
  if (plan.missingAssets) throw new Error(`Dry-run found ${plan.missingAssets} missing local asset(s); migration aborted`);

  await fs.mkdir(options.backupDir, { recursive: true });
  const backupPath = path.join(options.backupDir, `redbase-before-oss-migration-${timestampForFilename()}.sqlite`);
  const db = modules.getDatabase();
  await db.backup(backupPath);

  let migratedAssets = 0;
  let migratedBytes = 0;
  const failures = [];
  for (const generationPlan of plan.plans) {
    try {
      const result = await migrateGeneration(generationPlan, { storage, db });
      migratedAssets += result.migratedAssets;
      migratedBytes += result.migratedBytes;
    } catch (error) {
      failures.push({ generationId: generationPlan.generation.id, error: error.message });
    }
  }

  const finalSummary = {
    ...summary,
    backupPath,
    migratedAssets,
    migratedBytes,
    failedGenerations: failures.length,
    failures,
  };
  console.log(JSON.stringify(finalSummary));
  if (failures.length) process.exitCode = 2;
  return finalSummary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  inferMimeType,
  inferVariant,
  replaceLocalAssets,
  timestampForFilename,
  buildMigrationPlan,
  main,
};
