import { access, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const viteCacheDirectory = path.resolve("node_modules/.vite");

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function cacheEntryIsComplete(directory) {
  const metadataPath = path.join(directory, "_metadata.json");
  if (!(await fileExists(metadataPath))) return true;

  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const generatedFiles = [
      ...Object.values(metadata.optimized ?? {}),
      ...Object.values(metadata.chunks ?? {}),
    ]
      .map((entry) => entry?.file)
      .filter((file) => typeof file === "string");
    const checks = await Promise.all(
      generatedFiles.map((file) => fileExists(path.join(directory, file))),
    );
    return checks.every(Boolean);
  } catch {
    return false;
  }
}

let cacheDirectories;
try {
  cacheDirectories = (await readdir(viteCacheDirectory, {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("deps"))
    .map((entry) => path.join(viteCacheDirectory, entry.name));
} catch {
  cacheDirectories = [];
}

const cacheChecks = await Promise.all(
  cacheDirectories.map(cacheEntryIsComplete),
);
if (cacheChecks.some((complete) => !complete)) {
  await rm(viteCacheDirectory, { recursive: true, force: true });
  console.log("已清理不完整的 Vite 依赖缓存，将自动重新生成。");
}
