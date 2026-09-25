#!/usr/bin/env node
// Moves catalog photos and verification documents from data: URLs in the database to the private bucket.
//
//   node scripts/migrate-files-to-bucket.js                       dry run: what would be moved (changes nothing)
//   node scripts/migrate-files-to-bucket.js --apply               move: upload, then record the key; data: URLs stay
//   node scripts/migrate-files-to-bucket.js --verify              check every moved file exists in the bucket with the right size
//   node scripts/migrate-files-to-bucket.js --cleanup             dry run of the cleanup
//   node scripts/migrate-files-to-bucket.js --cleanup --apply     clear data: URLs whose file is verified in the bucket right now
//   node scripts/migrate-files-to-bucket.js --clear-invalid-images [--apply]
//                                                                 catalog imageUrl values that aren't a valid photo (links etc.)
//
// Safe to re-run: moved rows (key set) are skipped, and every write is conditional on the row being unchanged.
// Env: DATABASE_URL and S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY — nothing is
// read from .env files here; the caller passes them (see docs/AUDIT_STATUS.md for the production command).
const { PrismaClient } = require('@prisma/client');
const storage = require('../src/utils/storage');
const { checkDocument, checkCatalogImage } = require('../src/utils/documents');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const MODE = args.has('--verify') ? 'verify' : args.has('--cleanup') ? 'cleanup' : args.has('--clear-invalid-images') ? 'clear-invalid' : 'move';
const known = ['--apply', '--verify', '--cleanup', '--clear-invalid-images'];
const unknown = [...args].filter((a) => !known.includes(a));
if (unknown.length) { console.error('Unknown option(s): ' + unknown.join(' ')); process.exit(2); }
if (APPLY && MODE === 'verify') { console.error('--verify only reads; drop --apply'); process.exit(2); }

const db = new PrismaClient();
const PAGE = 25; // rows per query: data: URLs can be a few MB each
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

// Pages through a model by id, so large tables never load at once. "id > last" rather than a Prisma cursor:
// rows processed in a page may stop matching `where` (moved, cleared), which must not shift the next page.
async function* pages(model, where, select) {
  let last = null;
  for (;;) {
    const rows = await model.findMany({ where: last ? { AND: [where, { id: { gt: last } }] } : where, select, orderBy: { id: 'asc' }, take: PAGE });
    if (rows.length === 0) return;
    yield rows;
    last = rows[rows.length - 1].id;
  }
}

// The two kinds of files, described the same way
const KINDS = [
  {
    name: 'catalog photos', model: db.catalogItem, keyField: 'imageKey', legacyField: 'imageUrl', check: checkCatalogImage,
    prefix: (row) => 'catalog/' + row.supplierCompanyId, owner: { supplierCompanyId: true },
    record: (key, checked) => ({ imageKey: key, imageContentType: checked.contentType }),
    storedSize: () => null, // not recorded for photos; compared with the legacy data: URL while it exists
  },
  {
    name: 'verification documents', model: db.companyDocument, keyField: 'storageKey', legacyField: 'fileUrl', check: checkDocument,
    prefix: (row) => 'companies/' + row.companyId, owner: { companyId: true },
    record: (key, checked) => ({ storageKey: key, contentType: checked.contentType, sizeBytes: checked.buffer.length }),
    storedSize: (row) => row.sizeBytes,
  },
];

const summary = { problems: 0 };

async function move(kind) {
  let toMove = 0, bytes = 0, moved = 0, skippedRace = 0, invalid = [];
  const already = await kind.model.count({ where: { [kind.keyField]: { not: null } } });
  const where = { [kind.keyField]: null, [kind.legacyField]: { not: null } };
  for await (const rows of pages(kind.model, where, { id: true, [kind.legacyField]: true, ...kind.owner })) {
    for (const row of rows) {
      const value = row[kind.legacyField];
      if (value === '') continue;
      const checked = kind.check(value);
      if (checked.error) { invalid.push({ id: row.id, reason: checked.error, value: value.slice(0, 60) }); continue; }
      toMove++; bytes += checked.buffer.length;
      if (!APPLY) continue;
      const key = storage.newKey(kind.prefix(row));
      await storage.putObject(key, checked.buffer, checked.contentType);
      // record the key only if the row is still unmoved and unchanged (another run, or an edit, wins)
      const { count } = await kind.model.updateMany({ where: { id: row.id, [kind.keyField]: null, [kind.legacyField]: value }, data: kind.record(key, checked) });
      if (count === 1) moved++; else skippedRace++;
    }
  }
  console.log(`\n${kind.name}:`);
  console.log(`  already in the bucket: ${already}`);
  console.log(`  ${APPLY ? 'moved' : 'to move'}: ${APPLY ? moved : toMove} (${mb(bytes)})${skippedRace ? `, skipped ${skippedRace} changed meanwhile (their upload stays unused)` : ''}`);
  if (invalid.length) {
    console.log(`  not a valid file, left as is: ${invalid.length}`);
    for (const x of invalid.slice(0, 20)) console.log(`    ${x.id}: ${x.reason} — ${JSON.stringify(x.value)}`);
    if (invalid.length > 20) console.log(`    … and ${invalid.length - 20} more`);
  }
}

// Size a moved row's file must have: recorded size, else the legacy data: URL's (null if neither is known)
function expectedSize(kind, row) {
  const recorded = kind.storedSize(row);
  if (recorded) return recorded;
  const legacy = row[kind.legacyField];
  if (legacy) { const c = kind.check(legacy); if (!c.error) return c.buffer.length; }
  return null;
}

async function verify(kind) {
  let ok = 0; const bad = [];
  const select = { id: true, [kind.keyField]: true, [kind.legacyField]: true, ...(kind.keyField === 'storageKey' ? { sizeBytes: true } : {}) };
  for await (const rows of pages(kind.model, { [kind.keyField]: { not: null } }, select)) {
    for (const row of rows) {
      const head = await storage.headObject(row[kind.keyField]);
      const want = expectedSize(kind, row);
      if (!head) bad.push(`${row.id}: missing in the bucket`);
      else if (want !== null && head.size !== want) bad.push(`${row.id}: size ${head.size}, expected ${want}`);
      else ok++;
    }
  }
  console.log(`\n${kind.name}: ${ok} verified${bad.length ? `, ${bad.length} PROBLEM(S)` : ''}`);
  for (const b of bad) console.log('  ' + b);
  summary.problems += bad.length;
}

async function cleanup(kind) {
  let ready = 0, bytes = 0, cleared = 0; const notReady = [];
  const select = { id: true, [kind.keyField]: true, [kind.legacyField]: true, ...(kind.keyField === 'storageKey' ? { sizeBytes: true } : {}) };
  const where = { [kind.keyField]: { not: null }, [kind.legacyField]: { not: null } };
  for await (const rows of pages(kind.model, where, select)) {
    for (const row of rows) {
      // only clear what is in the bucket right now, with the size of the data it replaces
      const head = await storage.headObject(row[kind.keyField]);
      const want = expectedSize(kind, row);
      if (!head || (want !== null && head.size !== want)) { notReady.push(`${row.id}: ${head ? `size ${head.size}, expected ${want}` : 'missing in the bucket'}`); continue; }
      ready++; bytes += row[kind.legacyField].length;
      if (!APPLY) continue;
      const { count } = await kind.model.updateMany({ where: { id: row.id, [kind.keyField]: row[kind.keyField] }, data: { [kind.legacyField]: null } });
      cleared += count;
    }
  }
  console.log(`\n${kind.name}:`);
  console.log(`  ${APPLY ? 'cleared' : 'can be cleared'}: ${APPLY ? cleared : ready} data: URL(s), about ${mb(bytes)} of database space`);
  if (notReady.length) { console.log(`  NOT cleared (file not verified in the bucket): ${notReady.length}`); for (const x of notReady) console.log('    ' + x); }
  summary.problems += notReady.length;
}

async function clearInvalidImages() {
  const kind = KINDS[0];
  let found = 0, cleared = 0;
  for await (const rows of pages(kind.model, { imageKey: null, imageUrl: { not: null } }, { id: true, imageUrl: true })) {
    for (const row of rows) {
      if (!checkCatalogImage(row.imageUrl).error) continue; // a valid photo: moved by --apply, not cleared here
      found++;
      console.log(`  ${row.id}: ${JSON.stringify(row.imageUrl.slice(0, 60))}`);
      if (APPLY) cleared += (await kind.model.updateMany({ where: { id: row.id, imageKey: null, imageUrl: row.imageUrl }, data: { imageUrl: null } })).count;
    }
  }
  console.log(`\ncatalog photos that aren't a valid image: ${found}${APPLY ? `, cleared ${cleared}` : ' (dry run: nothing cleared)'}`);
}

(async () => {
  const dbHost = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (e) { return '?'; } })();
  console.log(`Mode: ${MODE}${APPLY ? ' (APPLY — changes data)' : ' (dry run — changes nothing)'}`);
  console.log(`Database host: ${dbHost}`);
  const needsBucket = APPLY || MODE === 'verify' || MODE === 'cleanup';
  if (needsBucket && !storage.isConfigured()) { console.error('S3_* variables are not set: the bucket is needed for this mode.'); process.exit(2); }
  if (storage.isConfigured()) console.log(`Bucket: ${process.env.S3_BUCKET}`);

  if (MODE === 'move') for (const k of KINDS) await move(k);
  if (MODE === 'verify') for (const k of KINDS) await verify(k);
  if (MODE === 'cleanup') for (const k of KINDS) await cleanup(k);
  if (MODE === 'clear-invalid') await clearInvalidImages();

  await db.$disconnect();
  if (summary.problems) { console.log(`\n${summary.problems} problem(s) — see above.`); process.exit(1); }
  console.log('\nDone.');
})().catch(async (e) => { console.error('FAILED:', e.message); await db.$disconnect(); process.exit(1); });
