#!/usr/bin/env node
// Restores files from the backup bucket into the main bucket (see scripts/backup-bucket.js).
//
//   node scripts/restore-bucket.js                      dry run: what would be restored (changes nothing)
//   node scripts/restore-bucket.js --apply              restore files missing from the main bucket
//   ... --prefix orders/<id>/                           only keys under a prefix
//   ... --key <key>                                     one file
//   ... --include-deleted                               also files in the backup's trash (_deleted/, deleted from
//                                                       the main bucket within the last 30 days): newest copy wins
//   ... --overwrite                                     also replace files that exist in the main bucket but differ
//                                                       (without it they are only listed)
//
// Env: S3_* (main bucket, the target) and BACKUP_S3_* (backup bucket, the source) — passed by the caller, e.g.
//   DOTENV_CONFIG_PATH=.env.production node -r dotenv/config scripts/restore-bucket.js
const { bucketFromEnv, sameBucket } = require('./lib/buckets');

const TRASH = '_deleted/';
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => ['--apply', '--overwrite', '--include-deleted'].includes(a)));
const valueOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const PREFIX = valueOf('--prefix');
const KEY = valueOf('--key');
const known = new Set(['--apply', '--overwrite', '--include-deleted', '--prefix', '--key', PREFIX, KEY].filter(Boolean));
const unknown = argv.filter((a) => !known.has(a));
if (unknown.length) { console.error('Unknown option(s): ' + unknown.join(' ')); process.exit(2); }
if ((argv.includes('--prefix') && !PREFIX) || (argv.includes('--key') && !KEY)) { console.error('--prefix and --key need a value'); process.exit(2); }
const APPLY = flags.has('--apply');
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';
const wanted = (key) => (KEY ? key === KEY : PREFIX ? key.startsWith(PREFIX) : true);

async function sameContent(backup, key, src, dst) {
  if (src.size !== dst.size) return false;
  if (src.etag === dst.etag) return true;
  const h = await backup.head(key);
  return !!h && h.metadata['source-etag'] === dst.etag;
}

(async () => {
  const main = bucketFromEnv('S3_');
  const backup = bucketFromEnv('BACKUP_S3_');
  if (!main || !backup) { console.error('S3_* and BACKUP_S3_* must both be set'); process.exit(2); }
  if (sameBucket(main, backup)) { console.error('The backup bucket is the main bucket'); process.exit(2); }
  console.log(`Mode: ${APPLY ? 'APPLY — writes to the main bucket' : 'dry run — changes nothing'}${flags.has('--overwrite') ? ', overwrite' : ''}${flags.has('--include-deleted') ? ', include deleted' : ''}`);
  console.log(`From backup: ${backup.name}  ->  to main: ${main.name}${PREFIX ? `  (prefix ${PREFIX})` : ''}${KEY ? `  (key ${KEY})` : ''}`);

  const target = await main.list();
  const all = await backup.list();
  // key -> backup object key to restore from (its current copy, else the newest trash copy)
  const sources = new Map();
  for (const [k, o] of all) if (!k.startsWith(TRASH) && wanted(k)) sources.set(k, { from: k, ...o });
  if (flags.has('--include-deleted')) {
    for (const [k, o] of [...all].filter(([x]) => x.startsWith(TRASH)).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const key = k.slice(TRASH.length + 11); // _deleted/YYYY-MM-DD/<key>
      if (!wanted(key)) continue;
      const cur = sources.get(key);
      if (!cur || cur.from.startsWith(TRASH)) sources.set(key, { from: k, ...o }); // later dates sort last: newest wins
    }
  }

  const plan = { missing: [], differs: [], same: 0 };
  for (const [key, src] of sources) {
    const dst = target.get(key);
    if (!dst) plan.missing.push({ key, ...src });
    else if (await sameContent(backup, src.from, src, dst)) plan.same++;
    else plan.differs.push({ key, ...src });
  }
  const restore = [...plan.missing, ...(flags.has('--overwrite') ? plan.differs : [])];
  const bytes = restore.reduce((a, x) => a + x.size, 0);

  console.log(`\nMissing from the main bucket: ${plan.missing.length}`);
  for (const x of plan.missing.slice(0, 50)) console.log(`  ${x.key}${x.from !== x.key ? `  (from ${x.from})` : ''}`);
  if (plan.missing.length > 50) console.log(`  … and ${plan.missing.length - 50} more`);
  console.log(`Different in the main bucket: ${plan.differs.length}${plan.differs.length && !flags.has('--overwrite') ? ' (kept; use --overwrite to replace)' : ''}`);
  for (const x of plan.differs.slice(0, 50)) console.log(`  ${x.key}`);
  console.log(`Already identical: ${plan.same}`);
  console.log(`${APPLY ? 'Restoring' : 'Would restore'}: ${restore.length} file(s), ${mb(bytes)}`);

  let failed = 0, done = 0;
  if (APPLY) {
    for (const x of restore) {
      try {
        const obj = await backup.get(x.from);
        await main.put(x.key, obj.body, obj.contentType);
        done++;
      } catch (err) { failed++; console.error(`ERROR ${x.key}: ${err.message}`); }
    }
    console.log(`Restored: ${done}${failed ? `, FAILED: ${failed}` : ''}`);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
