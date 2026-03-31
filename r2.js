import { readFile, unlink } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 via S3-compatible API.
 * Required env: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (or R2_BUCKET_NAME)
 * Optional env: R2_PUBLIC_BASE_URL (when absent, we try to derive it for public bucket URL)
 */
export function loadR2Config() {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET || process.env.R2_BUCKET_NAME;
  const publicBaseUrlFromEnv = process.env.R2_PUBLIC_BASE_URL;
  const keyPrefix = (process.env.R2_KEY_PREFIX || "").replace(/^\/+/, "").replace(/\/+$/, "");

  const missing = [];
  if (!endpoint) missing.push("R2_ENDPOINT");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!bucket) missing.push("R2_BUCKET (or R2_BUCKET_NAME)");

  if (missing.length) {
    throw new Error(`Missing R2 configuration: ${missing.join(", ")}`);
  }

  // When the bucket is configured as Public Access, direct GETs should work without auth.
  // For most R2 setups this "path-style" public URL works:
  //   ${R2_ENDPOINT}/${R2_BUCKET}/${key}
  // If your account uses a different public base URL, set R2_PUBLIC_BASE_URL explicitly.
  const publicBaseUrl =
    publicBaseUrlFromEnv ||
    `${endpoint.replace(/\/+$/, "")}/${bucket}`;

  return {
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl,
    keyPrefix,
  };
}

export function createR2Client(config) {
  return new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function buildObjectKey(prefix, name) {
  const base = prefix ? `${prefix}/${name}` : name;
  return base.replace(/\/{2,}/g, "/");
}

function publicUrlForKey(publicBaseUrl, key) {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${base}/${path}`;
}

/**
 * Uploads a local file to R2, deletes the local file, returns HTTPS public URL.
 */
function r2ErrorMessage(err) {
  if (!err || typeof err !== "object") return String(err);
  const code = err.name || err.Code || err.code || err.$fault;
  const msg = err.message || String(err);
  const http = err.$metadata?.httpStatusCode;
  const parts = ["R2 upload failed"];
  if (code) parts.push(`[${code}]`);
  if (http) parts.push(`HTTP ${http}`);
  parts.push(msg);
  return parts.join(" ");
}

export async function uploadLocalFileAndRemove(client, config, { localPath, objectName, contentType }) {
  const key = buildObjectKey(config.keyPrefix, objectName);
  try {
    const body = await readFile(localPath);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      );
    } catch (err) {
      const e = new Error(r2ErrorMessage(err));
      const http = err.$metadata?.httpStatusCode;
      e.statusCode =
        typeof http === "number" && http >= 400 && http < 600 ? http : 502;
      throw e;
    }
    return publicUrlForKey(config.publicBaseUrl, key);
  } finally {
    await unlink(localPath).catch(() => {});
  }
}
