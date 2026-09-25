#!/usr/bin/env node
// Daily backup of the file bucket into a second bucket — run by the Railway cron service "biddex-backup"
// (Cron Schedule 0 23 * * * UTC = 02:00 Bahrain; the process runs once and exits).
//
// - new files (and files whose content changed) are copied under the same key, so DB keys work on the backup;
// - a file deleted from the main bucket, and the previous version of a changed file, are kept in the backup
//   under _deleted/<YYYY-MM-DD>/<key> for BACKUP_RETENTION_DAYS (30), then removed;
// - safety: if too many files seem to have disappeared from the main bucket (wrong bucket/credentials),
//   nothing is moved to _deleted/ and an alert goes to Sentry;
// - errors go to Sentry with tag area=backup; the run exits 1 if anything failed; a Sentry cron monitor
//   (slug below) reports a run that failed or didn't happen at all.
//
// Env: S3_* (main bucket), BACKUP_S3_* (backup bucket), SENTRY_DSN, BACKUP_RETENTION_DAYS (default 30).
// BACKUP_NOW (ISO date) overrides "now" — for tests only.
const Sentry = require('@sentry/node');
const { bucketFromEnv, sameBucket } = require('./lib/buckets');

const MONITOR_SLUG = 'biddex-bucket-backup';
const MONITOR_CONFIG = { schedule: { type: 'crontab', value: '0 23 * * *' }, timezone: 'Etc/UTC', checkinMargin: 60, maxRuntime: 120 };
const TRASH = '_deleted/';
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);
// don't treat the main bucket as "mostly deleted" (likely misconfiguration) beyond this share of backed-up files
const MAX_DELETED_SHARE = 0.2;
const MIN_FILES_FOR_GUARD = 10;

Sentry.init({ dsn: process.env.SENTRY_DSN || undefined, environment: process.env.NODE_ENV || 'production' });

const now = process.env.BACKUP_NOW ? new Date(process.env.BACKUP_NOW) : new Date();
const today = now.toISOString().slice(0, 10);
const errors = [];

function report(err, step, extra = {}) {
  errors.push(`${step}${extra.key ? ' ' + extra.key : ''}: ${err.message}`);
  console.error(`ERROR ${step}${extra.key ? ' ' + extra.key : ''}: ${err.message}`);
  Sentry.captureException(err, { tags: { area: 'backup', step }, extra });
}

// Same content? Listed ETags usually match (plain MD5 of a single PUT); if they don't, the backup copy carries
// the main bucket's ETag in its metadata — checked with a HEAD, so a provider's ETag scheme never forces a re-copy.
async function sameContent(backup, key, src, dst) {
  if (src.size !== dst.size) return false;
  if (src.etag === dst.etag) return true;
  const h = await backup.head(key);
  return !!h && h.metadata['source-etag'] === src.etag;
}

// keeps the backup's current copy of `key` in the trash for the retention period, then drops it from its place
async function moveToTrash(backup, key) {
  await backup.copyWithin(key, `${TRASH}${today}/${key}`);
  await backup.remove(key);
}

async function run() {
  const main = bucketFromEnv('S3_');
  const backup = bucketFromEnv('BACKUP_S3_');
  if (!main || !backup) throw new Error('S3_* and BACKUP_S3_* must both be set');
  if (sameBucket(main, backup)) throw new Error('The backup bucket is the main bucket');
  console.log(`Backup ${main.name} -> ${backup.name} (${today}, trash kept ${RETENTION_DAYS} days)`);

  const source = await main.list();
  const all = await backup.list();
  const current = new Map([...all].filter(([k]) => !k.startsWith(TRASH)));
  const trash = [...all.keys()].filter((k) => k.startsWith(TRASH));
  const stats = { files: source.size, copied: 0, changed: 0, trashed: 0, purged: 0, unchanged: 0 };

  // new and changed files
  for (const [key, src] of source) {
    if (key.startsWith(TRASH)) continue; // never back up a trash-looking key from the main bucket
    try {
      const dst = current.get(key);
      if (dst && await sameContent(backup, key, src, dst)) { stats.unchanged++; continue; }
      if (dst) { await moveToTrash(backup, key); stats.changed++; } // keep the previous version for 30 days
      const obj = await main.get(key);
      await backup.put(key, obj.body, obj.contentType, { 'source-etag': obj.etag || src.etag });
      stats.copied++;
    } catch (err) { report(err, 'copy', { key }); }
  }

  // files gone from the main bucket -> trash (unless it looks like the wrong bucket)
  const gone = [...current.keys()].filter((k) => !source.has(k));
  const suspicious = current.size >= MIN_FILES_FOR_GUARD && (source.size === 0 || gone.length / current.size > MAX_DELETED_SHARE);
  if (suspicious) {
    const msg = `Backup guard: ${gone.length} of ${current.size} backed-up files are missing from ${main.name} — nothing moved to ${TRASH}. Check the S3_* variables.`;
    errors.push(msg);
    console.error('ERROR ' + msg);
    Sentry.captureMessage(msg, { level: 'error', tags: { area: 'backup', step: 'guard' }, extra: { missing: gone.length, backedUp: current.size, mainFiles: source.size } });
  } else {
    for (const key of gone) {
      try { await moveToTrash(backup, key); stats.trashed++; } catch (err) { report(err, 'trash', { key }); }
    }
  }

  // trash older than the retention period is removed for good
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400e3).toISOString().slice(0, 10);
  for (const key of trash) {
    const day = key.slice(TRASH.length, TRASH.length + 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= cutoff) continue;
    try { await backup.remove(key); stats.purged++; } catch (err) { report(err, 'purge', { key }); }
  }

  console.log('Summary ' + JSON.stringify(stats));
  if (errors.length) throw new Error(`${errors.length} backup error(s): ${errors[0]}`);
}

(async () => {
  let code = 0;
  try {
    // check-ins: in_progress, then ok — or error if run() throws; a missed run is flagged by Sentry itself
    await Sentry.withMonitor(MONITOR_SLUG, run, MONITOR_CONFIG);
    console.log('Backup finished');
  } catch (err) {
    code = 1;
    // per-file errors were reported already; a failure of the run itself (config, listing) is reported here
    if (!errors.length) Sentry.captureException(err, { tags: { area: 'backup', step: 'run' } });
    console.error('Backup FAILED: ' + err.message);
  }
  await Sentry.flush(5000);
  process.exit(code);
})();
