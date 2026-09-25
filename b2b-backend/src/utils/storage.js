// Private file storage: a Railway Storage Bucket (S3-compatible). Objects are never public — they are
// uploaded through the API (after access and content checks) and handed out as short-lived presigned
// download URLs, only to users the API has authorised. Objects are never overwritten (random keys).
//
// Env (set in Railway as references to the bucket's variables):
//   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
//   S3_FORCE_PATH_STYLE=true only for endpoints without virtual-hosted buckets (the local test server)
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
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
    client = new S3Client({ endpoint: c.endpoint, region: c.region, credentials: c.credentials, forcePathStyle: c.forcePathStyle });
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

module.exports = { isConfigured, newKey, putObject, presignDownload, attachmentDisposition, DOWNLOAD_URL_TTL_SECONDS };
