import { randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

type UploadMetadata = {
  key: string;
  fileName: string;
  contentType: string;
  fileSize: number;
};

const FIVE_GB = 5 * 1024 * 1024 * 1024;
const KEY_PATTERN = /^videos\/[a-zA-Z0-9._-]+$/;
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function sendJson(
  response: ServerResponse,
  value: unknown,
  statusCode = 200,
) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("request metadata is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function safeFileName(rawName: string) {
  let fileName = rawName;
  try {
    fileName = decodeURIComponent(rawName);
  } catch {
    fileName = "video.mp4";
  }
  const safeName =
    fileName
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "video.mp4";
  return { fileName, safeName };
}

export function localVideoStoragePlugin(): Plugin {
  const storageRoot = path.resolve(process.cwd(), ".syncwall-media");
  const uploadsRoot = path.join(storageRoot, "uploads");
  const videosRoot = path.join(storageRoot, "videos");

  return {
    name: "syncwall-local-video-storage",
    apply: "serve",
    async configureServer(server) {
      await Promise.all([
        mkdir(uploadsRoot, { recursive: true }),
        mkdir(videosRoot, { recursive: true }),
      ]);

      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://syncwall.local");
        if (
          url.pathname !== "/api/video/upload" &&
          url.pathname !== "/api/video"
        ) {
          next();
          return;
        }

        try {
          if (url.pathname === "/api/video/upload") {
            const action = url.searchParams.get("action");
            if (request.method === "POST" && action === "create") {
              const body = await readJson(request);
              const fileSize = Math.max(
                0,
                Math.round(Number(body.fileSize) || 0),
              );
              if (fileSize <= 0 || fileSize > FIVE_GB) {
                sendJson(response, { error: "invalid video size" }, 400);
                return;
              }
              const { fileName, safeName } = safeFileName(
                typeof body.fileName === "string"
                  ? body.fileName
                  : "video.mp4",
              );
              const uploadId = randomUUID();
              const key = `videos/${randomUUID()}-${safeName}`;
              const uploadDirectory = path.join(uploadsRoot, uploadId);
              await mkdir(uploadDirectory, { recursive: true });
              const metadata: UploadMetadata = {
                key,
                fileName,
                contentType:
                  typeof body.contentType === "string"
                    ? body.contentType.slice(0, 120)
                    : "application/octet-stream",
                fileSize,
              };
              await writeFile(
                path.join(uploadDirectory, "metadata.json"),
                JSON.stringify(metadata),
                "utf8",
              );
              sendJson(response, { key, uploadId });
              return;
            }

            const key = url.searchParams.get("key") ?? "";
            const uploadId = url.searchParams.get("uploadId") ?? "";
            if (!KEY_PATTERN.test(key) || !ID_PATTERN.test(uploadId)) {
              sendJson(response, { error: "invalid multipart upload" }, 400);
              return;
            }
            const uploadDirectory = path.join(uploadsRoot, uploadId);
            const metadata = JSON.parse(
              await readFile(
                path.join(uploadDirectory, "metadata.json"),
                "utf8",
              ),
            ) as UploadMetadata;
            if (metadata.key !== key) {
              sendJson(response, { error: "upload key mismatch" }, 409);
              return;
            }

            if (request.method === "PUT" && action === "part") {
              const partNumber = Math.round(
                Number(url.searchParams.get("partNumber")) || 0,
              );
              if (partNumber < 1 || partNumber > 10000) {
                sendJson(response, { error: "invalid part number" }, 400);
                return;
              }
              const partPath = path.join(
                uploadDirectory,
                `${partNumber}.part`,
              );
              await pipeline(
                request,
                createWriteStream(partPath, { highWaterMark: 4 * 1024 * 1024 }),
              );
              const partStat = await stat(partPath);
              sendJson(response, {
                partNumber,
                etag: `${partNumber}-${partStat.size}-${partStat.mtimeMs}`,
              });
              return;
            }

            if (request.method === "POST" && action === "complete") {
              const body = await readJson(request);
              const parts = Array.isArray(body.parts)
                ? body.parts
                    .map((part) =>
                      Math.round(
                        Number(
                          (part as { partNumber?: unknown }).partNumber,
                        ) || 0,
                      ),
                    )
                    .filter((partNumber) => partNumber > 0)
                    .sort((left, right) => left - right)
                : [];
              if (!parts.length) {
                sendJson(response, { error: "missing uploaded parts" }, 400);
                return;
              }
              const baseName = key.slice("videos/".length);
              const finalPath = path.join(videosRoot, baseName);
              for (let index = 0; index < parts.length; index += 1) {
                await pipeline(
                  createReadStream(
                    path.join(uploadDirectory, `${parts[index]}.part`),
                    { highWaterMark: 4 * 1024 * 1024 },
                  ),
                  createWriteStream(finalPath, {
                    flags: index === 0 ? "w" : "a",
                    highWaterMark: 4 * 1024 * 1024,
                  }),
                );
              }
              const finalStat = await stat(finalPath);
              if (finalStat.size !== metadata.fileSize) {
                await rm(finalPath, { force: true });
                sendJson(
                  response,
                  {
                    error: `video size mismatch (${finalStat.size}/${metadata.fileSize})`,
                  },
                  409,
                );
                return;
              }
              await writeFile(
                `${finalPath}.json`,
                JSON.stringify(metadata),
                "utf8",
              );
              await rm(uploadDirectory, { recursive: true, force: true });
              sendJson(response, {
                key,
                url: `/api/video?key=${encodeURIComponent(key)}`,
              });
              return;
            }

            if (request.method === "DELETE") {
              await rm(uploadDirectory, { recursive: true, force: true });
              sendJson(response, { ok: true });
              return;
            }

            sendJson(response, { error: "method not allowed" }, 405);
            return;
          }

          const key = url.searchParams.get("key") ?? "";
          if (!KEY_PATTERN.test(key)) {
            sendJson(response, { error: "invalid video key" }, 400);
            return;
          }
          if (request.method !== "GET" && request.method !== "HEAD") {
            sendJson(response, { error: "method not allowed" }, 405);
            return;
          }
          const finalPath = path.join(
            videosRoot,
            key.slice("videos/".length),
          );
          const [fileStat, metadata] = await Promise.all([
            stat(finalPath),
            readFile(`${finalPath}.json`, "utf8").then(
              (value) => JSON.parse(value) as UploadMetadata,
            ),
          ]);
          let start = 0;
          let end = fileStat.size - 1;
          let statusCode = 200;
          const range = request.headers.range;
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
            if (!match) {
              response.statusCode = 416;
              response.setHeader("content-range", `bytes */${fileStat.size}`);
              response.end();
              return;
            }
            if (match[1]) {
              start = Number(match[1]);
              end = match[2]
                ? Math.min(Number(match[2]), fileStat.size - 1)
                : fileStat.size - 1;
            } else if (match[2]) {
              const suffix = Math.min(Number(match[2]), fileStat.size);
              start = fileStat.size - suffix;
            }
            if (
              !Number.isFinite(start) ||
              !Number.isFinite(end) ||
              start < 0 ||
              start > end ||
              start >= fileStat.size
            ) {
              response.statusCode = 416;
              response.setHeader("content-range", `bytes */${fileStat.size}`);
              response.end();
              return;
            }
            statusCode = 206;
          }
          response.statusCode = statusCode;
          response.setHeader("content-type", metadata.contentType);
          response.setHeader("accept-ranges", "bytes");
          response.setHeader("content-length", String(end - start + 1));
          response.setHeader("cache-control", "private, max-age=3600");
          if (statusCode === 206) {
            response.setHeader(
              "content-range",
              `bytes ${start}-${end}/${fileStat.size}`,
            );
          }
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          await pipeline(
            createReadStream(finalPath, {
              start,
              end,
              highWaterMark: 2 * 1024 * 1024,
            }),
            response,
          );
        } catch (error) {
          if (!response.headersSent) {
            sendJson(
              response,
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "local video storage failed",
              },
              500,
            );
          } else {
            response.destroy(error instanceof Error ? error : undefined);
          }
        }
      });
    },
  };
}
