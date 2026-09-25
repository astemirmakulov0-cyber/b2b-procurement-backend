// Private file storage: a Railway Storage Bucket (S3-compatible). Objects are never public — they are
// uploaded through the API (after access and content checks) and handed out as short-lived presigned
// download URLs, only to users the API has authorised. Objects are never overwritten (random keys).
//
// Env (set in Railway as references to the bucket's variables):
//   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
//   S3_FORCE_PATH_STYLE=true only for endpoints without virtual-hosted buckets (the local test server)
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const DOWNLOAD_URL_TTL_SECONDS = 120;

let client = null;

function config() {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: S3_ENDPOINT, region: S3_REGION || 'auto', bucket: S3_BUCKET,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  };
}

const isConfigured = () => config() !== null;

function s3() {
  if (!client) {
    const c = config();
    if (!c) throw Object.assign(new Error('File storage is not configured'), { status: 503 });
    client = new S3Client({
      endpoint: c.endpoint, region: c.region, credentials: c.credentials, forcePathStyle: c.forcePathStyle,
      // checksums only where the S3 API requires them: the SDK's default (added in 2025) sends extra checksum
      // headers/parameters that S3-compatible stores don't all support
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

// A new random key under a prefix, e.g. "orders/<orderId>/<uuid>"; the original file name is kept in the DB only
const newKey = (prefix) => `${prefix}/${crypto.randomUUID()}`;

async function putObject(key, body, contentType) {
  await s3().send(new PutObjectCommand({ Bucket: config().bucket, Key: key, Body: body, ContentType: contentType }));
}

// Content-Disposition for a download under the original name: an ASCII fallback plus the UTF-8 name (RFC 6266)
function attachmentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// A URL that downloads the object (as an attachment, never rendered inline) for the next 120 seconds
async function presignDownload(key, fileName, contentType) {
  const cmd = new GetObjectCommand({
    Bucket: config().bucket, Key: key,
    ResponseContentDisposition: attachmentDisposition(fileName),
    ResponseContentType: contentType,
  });
  return getSignedUrl(s3(), cmd, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
}

// A URL that shows the object in the page (iframe / img) for the next 120 seconds — for PDFs and raster
// images only, which is all the upload checks let in
async function presignView(key, contentType) {
  const cmd = new GetObjectCommand({ Bucket: config().bucket, Key: key, ResponseContentDisposition: 'inline', ResponseContentType: contentType });
  return getSignedUrl(s3(), cmd, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
}

// Catalog photos: signed as of the start of the current hour and valid for 2 hours, so the URL stays the
// same within the hour (the browser caches the image, the catalog list doesn't change on every refresh)
// and is valid for at least an hour after it was handed out.
const STABLE_URL_WINDOW_MS = 60 * 60 * 1000;
const STABLE_URL_TTL_SECONDS = 2 * 60 * 60;
async function presignStable(key, contentType, now = Date.now()) {
  const cmd = new GetObjectCommand({ Bucket: config().bucket, Key: key, ResponseContentType: contentType });
  const signingDate = new Date(Math.floor(now / STABLE_URL_WINDOW_MS) * STABLE_URL_WINDOW_MS);
  return getSignedUrl(s3(), cmd, { expiresIn: STABLE_URL_TTL_SECONDS, signingDate });
}

// { size } of a stored object, or null if it doesn't exist
async function headObject(key) {
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: config().bucket, Key: key }));
    return { size: r.ContentLength };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

module.exports = {
  isConfigured, newKey, putObject, presignDownload, presignView, presignStable, headObject, attachmentDisposition,
  DOWNLOAD_URL_TTL_SECONDS, STABLE_URL_TTL_SECONDS,
};
