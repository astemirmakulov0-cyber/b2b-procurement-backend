// S3 access for the backup and restore scripts: two buckets with their own credentials, configured by env
// prefix — S3_ (the main bucket, as the API uses it) and BACKUP_S3_ (the backup bucket).
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// A bucket handle from `${prefix}ENDPOINT / REGION / BUCKET / ACCESS_KEY_ID / SECRET_ACCESS_KEY`, or null if incomplete
function bucketFromEnv(prefix) {
  const env = (k) => process.env[prefix + k];
  if (!env('ENDPOINT') || !env('BUCKET') || !env('ACCESS_KEY_ID') || !env('SECRET_ACCESS_KEY')) return null;
  const s3 = new S3Client({
    endpoint: env('ENDPOINT'), region: env('REGION') || 'auto',
    credentials: { accessKeyId: env('ACCESS_KEY_ID'), secretAccessKey: env('SECRET_ACCESS_KEY') },
    forcePathStyle: env('FORCE_PATH_STYLE') === 'true',
    // checksums only where the S3 API requires them (as in src/utils/storage.js)
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const name = env('BUCKET');
  const endpoint = env('ENDPOINT');
  return {
    name, endpoint,
    // every object under a prefix: Map key -> { size, etag }
    async list(prefix = '') {
      const out = new Map();
      let token;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: name, Prefix: prefix || undefined, ContinuationToken: token }));
        for (const o of r.Contents || []) out.set(o.Key, { size: o.Size, etag: o.ETag });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    // { body: Buffer, contentType, etag }
    async get(key) {
      const r = await s3.send(new GetObjectCommand({ Bucket: name, Key: key }));
      return { body: Buffer.from(await r.Body.transformToByteArray()), contentType: r.ContentType, etag: r.ETag };
    },
    async put(key, body, contentType, metadata) {
      await s3.send(new PutObjectCommand({ Bucket: name, Key: key, Body: body, ContentType: contentType, Metadata: metadata }));
    },
    // { size, etag, metadata } or null if missing
    async head(key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: name, Key: key }));
        return { size: r.ContentLength, etag: r.ETag, metadata: r.Metadata || {} };
      } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    // server-side copy inside this bucket (metadata and content type are kept)
    async copyWithin(fromKey, toKey) {
      await s3.send(new CopyObjectCommand({ Bucket: name, Key: toKey, CopySource: `${name}/${fromKey.split('/').map(encodeURIComponent).join('/')}` }));
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: name, Key: key }));
    },
  };
}

// The same bucket twice would make the "backup" a copy of itself
const sameBucket = (a, b) => a.name === b.name && a.endpoint.replace(/\/+$/, '') === b.endpoint.replace(/\/+$/, '');

module.exports = { bucketFromEnv, sameBucket };
