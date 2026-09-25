// Integration tests. Run via `npm test` (test/run.js), which starts a throwaway local Postgres and passes
// its URL in DATABASE_URL. Env is set before the app loads dotenv, and dotenv never overrides existing
// vars, so the production DATABASE_URL in .env is never used — and the guard below refuses anything
// that isn't a local database.
const path = require('path');
const root = path.join(__dirname, '..');

const dbUrl = new URL(process.env.DATABASE_URL || 'missing://');
if (!['127.0.0.1', 'localhost'].includes(dbUrl.hostname) || !process.env.TEST_APP_PORT) {
  console.error('Refusing to run: integration tests only run against the local Postgres started by `npm test`.');
  process.exit(1);
}
process.env.JWT_SECRET = 'itest-secret-0123456789-abcdefghij-long-enough';
process.env.PORT = process.env.TEST_APP_PORT;
process.env.RESEND_API_KEY = 're_test_dummy';
process.env.SENTRY_DSN = '';

// Stub Sentry so no test event is ever sent; captured errors/messages are kept for assertions
const sentryCaptured = [];
const sentryPath = require.resolve('@sentry/node');
require.cache[sentryPath] = { id: sentryPath, filename: sentryPath, loaded: true,
  exports: { init() {}, setupExpressErrorHandler() {}, captureException(err, ctx) { sentryCaptured.push({ err, ctx }); }, captureMessage(msg, level) { sentryCaptured.push({ msg, level }); } } };

// Stub Resend so tests never call the real email API; sent emails are recorded, and a delay can be set
// to simulate a slow email API
const sentEmails = [];
let emailDelayMs = 0;
const resendPath = require.resolve('resend');
require.cache[resendPath] = { id: resendPath, filename: resendPath, loaded: true,
  exports: { Resend: class { constructor() { this.emails = { send: async (msg) => { if (emailDelayMs) await new Promise((r) => setTimeout(r, emailDelayMs)); sentEmails.push(msg); return { error: null }; } }; } } } };

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const BASE = `http://127.0.0.1:${process.env.TEST_APP_PORT}/api`;

let pass = 0, fail = 0;
const check = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); };
const tok = (role, companyId) => jwt.sign({ id: 'u-' + (companyId || role), role, companyId }, process.env.JWT_SECRET);
async function call(method, p, token, body, raw, extraHeaders) {
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}
const bal = async (companyId) => Number((await db.wallet.findUnique({ where: { companyId } })).balance);

async function seed() {
  for (const t of ['Notification','Message','Payment','Invoice','Delivery','Order','LPO','Quote','RFQ','WalletTransaction','Wallet','CompanyDocument','CatalogItem','Company','User'])
    await db.$executeRawUnsafe(`DELETE FROM "${t}"`);
  const mk = async (id, role, balance) => db.user.create({ data: { id: 'u-' + id, email: id + '@t.test', passwordHash: 'x', role, emailVerified: true,
    company: { create: { id, name: 'Co ' + id, type: role, verificationStatus: 'VERIFIED', wallet: { create: { balance } } } } } });
  await db.user.create({ data: { id: 'u-ADMIN', email: 'admin@t.test', passwordHash: 'x', role: 'ADMIN', emailVerified: true } });
  await mk('buyer1', 'BUYER', 0); await mk('buyer2', 'BUYER', 0);
  await mk('sup1', 'SUPPLIER', 100); await mk('sup2', 'SUPPLIER', 100); await mk('sup3', 'SUPPLIER', 25);
}
const future = () => new Date(Date.now() + 7 * 86400e3).toISOString();
async function newRfq(budget = 500, extra = {}) {
  const r = await call('POST', '/rfqs', tok('BUYER', 'buyer1'), { title: 'T', description: 'D', budget, deadline: future(), publish: true, ...extra });
  return r.data;
}

(async () => {
  require(path.join(root, 'src/index.js'));
  await new Promise((r) => setTimeout(r, 800));
  await seed();
  const B1 = tok('BUYER', 'buyer1'), B2 = tok('BUYER', 'buyer2'), S1 = tok('SUPPLIER', 'sup1'), S2 = tok('SUPPLIER', 'sup2'), S3 = tok('SUPPLIER', 'sup3'), ADM = tok('ADMIN', null);

  console.log('\n== 1. role check before JSON validation ==');
  check('supplier + malformed JSON -> 403', (await call('POST', '/wallet/topup', S1, null, '{amount:20}')).status === 403);
  check('buyer + malformed JSON -> 403', (await call('POST', '/wallet/topup', B1, null, '{amount:20}')).status === 403);
  check('no token + malformed JSON -> 401', (await call('POST', '/wallet/topup', null, null, '{amount:20}')).status === 401);
  const a = await call('POST', '/wallet/topup', ADM, null, '{amount:20}');
  check('admin + malformed JSON -> 400 Invalid JSON body', a.status === 400 && a.data.error === 'Invalid JSON body', a);
  check('admin valid top-up -> 201', (await call('POST', '/wallet/topup', ADM, { companyId: 'sup2', amount: 10 })).status === 201);
  await db.wallet.update({ where: { companyId: 'sup2' }, data: { balance: 100 } });

  console.log('\n== 2. deadlines (M8) ==');
  let r = await call('POST', '/rfqs', B1, { title: 'x', description: 'y', budget: 100, deadline: '2020-01-01' });
  check('create RFQ with past deadline -> 400', r.status === 400, r.data);
  r = await call('POST', '/rfqs', B1, { title: 'x', description: 'y', budget: 100, deadline: 'nonsense' });
  check('create RFQ with invalid deadline -> 400', r.status === 400, r.data);
  const expired = await newRfq(100);
  await db.rFQ.update({ where: { id: expired.id }, data: { deadline: new Date(Date.now() - 60e3) } });
  r = await call('POST', `/rfqs/${expired.id}/quotes`, S1, { price: 90 });
  check('quote after deadline -> 400', r.status === 400 && /deadline/.test(r.data.error), r.data);
  check('no fee charged for rejected late quote', (await bal('sup1')) === 100);

  console.log('\n== 3. edit RFQ ==');
  const e = await newRfq(200);
  r = await call('PATCH', `/rfqs/${e.id}`, B1, { title: 'T2', budget: 300, deadline: future() });
  check('edit before quotes -> 200', r.status === 200 && r.data.title === 'T2' && Number(r.data.budget) === 300, r.data);
  check('edit by other buyer -> 403', (await call('PATCH', `/rfqs/${e.id}`, B2, { title: 'hack' })).status === 403);
  check('edit with past deadline -> 400', (await call('PATCH', `/rfqs/${e.id}`, B1, { deadline: '2020-01-01' })).status === 400);
  check('edit budget negative -> 400', (await call('PATCH', `/rfqs/${e.id}`, B1, { budget: -5 })).status === 400);
  check('PATCH status CANCELLED no longer allowed -> 400', (await call('PATCH', `/rfqs/${e.id}`, B1, { status: 'CANCELLED' })).status === 400);
  check('quote on edited RFQ -> 201 (fee 5% of 300 = 15)', (await call('POST', `/rfqs/${e.id}/quotes`, S1, { price: 250 })).status === 201);
  check('sup1 balance 85', (await bal('sup1')) === 85);
  r = await call('PATCH', `/rfqs/${e.id}`, B1, { title: 'T3' });
  check('edit after a quote -> 409', r.status === 409, r.data);

  console.log('\n== 4. cancel RFQ with refunds ==');
  await db.wallet.updateMany({ where: { companyId: { in: ['sup1', 'sup2'] } }, data: { balance: 100 } });
  const c = await newRfq(500);
  check('sup1 quotes (fee 25)', (await call('POST', `/rfqs/${c.id}/quotes`, S1, { price: 400 })).status === 201);
  check('sup2 quotes (fee 25)', (await call('POST', `/rfqs/${c.id}/quotes`, S2, { price: 450 })).status === 201);
  await call('PATCH', `/quotes/${(await db.quote.findFirst({ where: { rfqId: c.id, supplierCompanyId: 'sup2' } })).id}/shortlist`, B1);
  check('balances 75/75 before cancel', (await bal('sup1')) === 75 && (await bal('sup2')) === 75);
  check('supplier cannot cancel -> 403', (await call('POST', `/rfqs/${c.id}/cancel`, S1)).status === 403);
  check('other buyer cannot cancel -> 403', (await call('POST', `/rfqs/${c.id}/cancel`, B2)).status === 403);
  r = await call('POST', `/rfqs/${c.id}/cancel`, B1);
  check('owner cancels -> 200 with 2 refunds of 25.000', r.status === 200 && r.data.refunds.length === 2 && r.data.refunds.every((x) => x.amount === '25.000'), r.data);
  check('balances restored to 100/100', (await bal('sup1')) === 100 && (await bal('sup2')) === 100);
  const rfqRow = await db.rFQ.findUnique({ where: { id: c.id } });
  check('RFQ kept in DB with status CANCELLED', rfqRow && rfqRow.status === 'CANCELLED');
  const qs = await db.quote.findMany({ where: { rfqId: c.id } });
  check('quotes (incl. shortlisted) -> REJECTED', qs.length === 2 && qs.every((q) => q.status === 'REJECTED'), qs.map((q) => q.status));
  const refundTx = await db.walletTransaction.findMany({ where: { type: 'REFUND' } });
  check('2 REFUND ledger entries "Refund: RFQ cancelled (...)" +25', refundTx.length === 2 && refundTx.every((t) => Number(t.amount) === 25 && t.reference.startsWith('Refund: RFQ cancelled')), refundTx.map((t) => t.reference));
  const notes = await db.notification.findMany({ where: { type: 'RFQ_CANCELLED' } });
  check('both suppliers notified', notes.length === 2 && new Set(notes.map((n) => n.companyId)).size === 2, notes.map((n) => n.body));
  check('cancel twice -> 400 (no double refund)', (await call('POST', `/rfqs/${c.id}/cancel`, B1)).status === 400 && (await bal('sup1')) === 100);
  check('quote on cancelled RFQ -> 400', (await call('POST', `/rfqs/${c.id}/quotes`, tok('SUPPLIER', 'sup3'), { price: 1 })).status === 400);
  const q1 = qs.find((q) => q.supplierCompanyId === 'sup1');
  check('award on cancelled RFQ -> 400', (await call('POST', `/quotes/${q1.id}/award`, B1, {})).status === 400);

  const d = await newRfq(100, { publish: false });
  r = await call('POST', `/rfqs/${d.id}/cancel`, B1);
  check('cancel DRAFT with no quotes -> 200, 0 refunds', r.status === 200 && r.data.refunds.length === 0, r.data);

  const aw = await newRfq(100);
  await call('POST', `/rfqs/${aw.id}/quotes`, S1, { price: 90 });
  const awq = await db.quote.findFirst({ where: { rfqId: aw.id } });
  check('award -> 201', (await call('POST', `/quotes/${awq.id}/award`, B1, {})).status === 201);
  r = await call('POST', `/rfqs/${aw.id}/cancel`, B1);
  check('cancel AWARDED -> 400', r.status === 400, r.data);

  const qc = await newRfq(100);
  check('close quoting -> 200', (await call('PATCH', `/rfqs/${qc.id}`, B1, { status: 'QUOTING_CLOSED' })).status === 200);
  check('cancel QUOTING_CLOSED -> 200', (await call('POST', `/rfqs/${qc.id}/cancel`, B1)).status === 200);

  console.log('\n== 5. concurrency ==');
  await db.wallet.update({ where: { companyId: 'sup1' }, data: { balance: 100 } });
  const cc = await newRfq(500);
  const burst = await Promise.all(Array.from({ length: 6 }, () => call('POST', `/rfqs/${cc.id}/quotes`, S1, { price: 400 })));
  const codes = burst.map((x) => x.status).sort();
  check('6 parallel quotes, same supplier -> one 201, rest 409', codes.filter((s) => s === 201).length === 1 && codes.filter((s) => s === 409).length === 5, codes);
  check('charged exactly once (100 - 25 = 75)', (await bal('sup1')) === 75);

  // sup3 has 25 credits: two parallel bids of 25 on different RFQs -> exactly one succeeds, never negative
  const x1 = await newRfq(500), x2 = await newRfq(500);
  const two = await Promise.all([call('POST', `/rfqs/${x1.id}/quotes`, S3, { price: 1 }), call('POST', `/rfqs/${x2.id}/quotes`, S3, { price: 1 })]);
  check('parallel bids with balance for one -> 201 + 402', two.map((x) => x.status).sort().join() === '201,402', two.map((x) => x.status));
  check('sup3 balance 0, not negative', (await bal('sup3')) === 0);

  // cancel racing with a new quote: either the quote is refunded, or it is rejected — never charged and lost
  await db.wallet.update({ where: { companyId: 'sup2' }, data: { balance: 100 } });
  const rc = await newRfq(500);
  const [qr, cr] = await Promise.all([call('POST', `/rfqs/${rc.id}/quotes`, S2, { price: 1 }), call('POST', `/rfqs/${rc.id}/cancel`, B1)]);
  check('quote vs cancel race: sup2 ends at 100', (await bal('sup2')) === 100, { quote: qr.status, cancel: cr.status });

  console.log('\n== 6. M19 consent ==');
  const reg = (consent) => call('POST', '/auth/register', null, { email: 'new' + Math.random() + '@t.test', password: 'secret123', role: 'BUYER', companyName: 'N', consent });
  r = await reg(undefined); check('register without consent -> 400', r.status === 400, r.data);
  r = await reg(false); check('register consent=false -> 400', r.status === 400);
  r = await reg('yes'); check('register consent="yes" (not true) -> 400', r.status === 400);
  r = await reg(true); check('register consent=true -> 201', r.status === 201, r.data);
  const newest = await db.company.findFirst({ where: { name: 'N' }, orderBy: { createdAt: 'desc' } });
  check('consentAt stored', !!(newest && newest.consentAt));

  console.log('\n== 7. M4 buyer anonymity ==');
  await db.wallet.updateMany({ where: { companyId: { in: ['sup1', 'sup2'] } }, data: { balance: 100 } });
  const an = await newRfq(100);
  await call('POST', `/rfqs/${an.id}/quotes`, S1, { price: 50 });
  await call('POST', `/rfqs/${an.id}/quotes`, S2, { price: 60 });
  const list = (await call('GET', '/rfqs', S2)).data;
  const inList = list.find((x) => x.id === an.id);
  check('supplier list: no buyerCompanyId / buyerCompany / _count', inList && !('buyerCompanyId' in inList) && !('buyerCompany' in inList) && !('_count' in inList), Object.keys(inList || {}));
  check('supplier list: only own quote', inList.quotes.length === 1);
  const buyerList = (await call('GET', '/rfqs', B1)).data.find((x) => x.id === an.id);
  check('buyer list still has _count', buyerList && buyerList._count.quotes === 2);
  let one = (await call('GET', `/rfqs/${an.id}`, S2)).data;
  check('supplier detail before award: no buyer id', !('buyerCompanyId' in one) && one.buyerCompany && !('id' in one.buyerCompany) && one.buyerCompany.name === 'Hidden until awarded', one.buyerCompany);
  const q1an = await db.quote.findFirst({ where: { rfqId: an.id, supplierCompanyId: 'sup1' } });
  await call('POST', `/quotes/${q1an.id}/award`, B1, {});
  one = (await call('GET', `/rfqs/${an.id}`, S1)).data;
  check('awarded supplier sees buyer', one.buyerCompanyId === 'buyer1' && one.buyerCompany.name === 'Co buyer1', one.buyerCompany);
  one = (await call('GET', `/rfqs/${an.id}`, S2)).data;
  check('losing supplier still anonymous', !('buyerCompanyId' in one) && one.buyerCompany.name === 'Hidden until awarded');

  console.log('\n== 8. M1 deactivation ==');
  const pw = await bcrypt.hash('pw123456', 4);
  await db.user.create({ data: { id: 'u-buyer3', email: 'buyer3@t.test', passwordHash: pw, role: 'BUYER', emailVerified: true,
    company: { create: { id: 'buyer3', name: 'Co buyer3', type: 'BUYER', verificationStatus: 'VERIFIED', wallet: { create: { balance: 0 } } } } } });
  const B3 = tok('BUYER', 'buyer3');
  await db.wallet.update({ where: { companyId: 'sup1' }, data: { balance: 100 } });
  const d3 = await call('POST', '/rfqs', B3, { title: 'B3 rfq', description: 'x', budget: 200, deadline: future(), publish: true });
  check('sup1 quotes on buyer3 RFQ (fee 10)', (await call('POST', `/rfqs/${d3.data.id}/quotes`, S1, { price: 150 })).status === 201 && (await bal('sup1')) === 90);
  const draft3 = await call('POST', '/rfqs', B3, { title: 'B3 draft', description: 'x', budget: 50, deadline: future() });
  check('buyer3 login works before', (await call('POST', '/auth/login', null, { email: 'buyer3@t.test', password: 'pw123456' })).status === 200);
  r = await call('DELETE', '/auth/me', B3);
  check('buyer3 deactivates -> 200, 2 RFQs cancelled', r.status === 200 && r.data.cancelledRfqs === 2, r.data);
  check('sup1 refunded on deactivation (back to 100)', (await bal('sup1')) === 100);
  check('sup1 notified', (await db.notification.count({ where: { companyId: 'sup1', type: 'RFQ_CANCELLED', body: { contains: 'B3 rfq' } } })) === 1);
  r = await call('GET', '/rfqs', B3);
  check('old buyer3 token -> 401 Account deactivated', r.status === 401 && r.data.error === 'Account deactivated', r.data);
  r = await call('POST', '/auth/login', null, { email: 'buyer3@t.test', password: 'pw123456' });
  check('buyer3 login -> 403 deactivated', r.status === 403 && /deactivated/.test(r.data.error), r.data);
  r = await call('POST', '/auth/login', null, { email: 'buyer3@t.test', password: 'wrong' });
  check('wrong password on deactivated account -> 401 (state not revealed)', r.status === 401 && r.data.error === 'Invalid credentials');
  check('RFQ rows kept (CANCELLED)', (await db.rFQ.count({ where: { buyerCompanyId: 'buyer3', status: 'CANCELLED' } })) === 2);
  check('deactivated buyer RFQs not in supplier feed', !(await call('GET', '/rfqs', S1)).data.some((x) => x.id === d3.data.id || x.id === draft3.data.id));

  // supplier deactivation: open quote withdrawn, can't be awarded, catalog hidden
  await db.user.create({ data: { id: 'u-sup4', email: 'sup4@t.test', passwordHash: pw, role: 'SUPPLIER', emailVerified: true,
    company: { create: { id: 'sup4', name: 'Co sup4', type: 'SUPPLIER', verificationStatus: 'VERIFIED', wallet: { create: { balance: 100 } } } } } });
  const S4 = tok('SUPPLIER', 'sup4');
  const s4rfq = await newRfq(100);
  await call('POST', `/rfqs/${s4rfq.id}/quotes`, S4, { price: 70 });
  await call('POST', '/catalog', S4, { name: 'sup4 item', price: 5 });
  check('sup4 item visible before', (await call('GET', '/catalog', B1)).data.some((i) => i.name === 'sup4 item'));
  check('sup4 deactivates -> 200', (await call('DELETE', '/auth/me', S4)).status === 200);
  const q4 = await db.quote.findFirst({ where: { supplierCompanyId: 'sup4' } });
  check('sup4 quote -> WITHDRAWN', q4.status === 'WITHDRAWN');
  r = await call('POST', `/quotes/${q4.id}/award`, B1, {});
  check('award withdrawn quote -> 400', r.status === 400, r.data);
  check('rfq still PUBLISHED after failed award', (await db.rFQ.findUnique({ where: { id: s4rfq.id } })).status === 'PUBLISHED');
  check('sup4 catalog hidden', !(await call('GET', '/catalog', B1)).data.some((i) => i.name === 'sup4 item'));
  check('active users unaffected', (await call('GET', '/rfqs', S1)).status === 200 && (await call('GET', '/rfqs', B1)).status === 200);

  console.log('\n== 9. M5 decline LPO -> RFQ can be awarded again ==');
  await db.wallet.updateMany({ where: { companyId: { in: ['sup1', 'sup2', 'sup3'] } }, data: { balance: 100 } });
  const dr = await newRfq(100);
  for (const s of [S1, S2, S3]) await call('POST', `/rfqs/${dr.id}/quotes`, s, { price: 80 });
  const qOf = async (sid) => db.quote.findFirst({ where: { rfqId: dr.id, supplierCompanyId: sid } });
  await call('PATCH', `/quotes/${(await qOf('sup2')).id}/shortlist`, B1);
  await call('PATCH', `/quotes/${(await qOf('sup3')).id}/reject`, B1);
  check('award sup1 -> 201', (await call('POST', `/quotes/${(await qOf('sup1')).id}/award`, B1, {})).status === 201);
  check('others after award: sup2 REJECTED (was SHORTLISTED), sup3 REJECTED (manual)',
    (await qOf('sup2')).status === 'REJECTED' && (await qOf('sup2')).statusBeforeAward === 'SHORTLISTED' && (await qOf('sup3')).statusBeforeAward === null);
  const lpo1 = await db.lPO.findFirst({ where: { rfqId: dr.id } });
  check('other supplier cannot decline -> 403', (await call('PATCH', `/lpos/${lpo1.id}/decline`, S2, {})).status === 403);
  r = await call('PATCH', `/lpos/${lpo1.id}/decline`, S1, { reason: 'No stock' });
  check('winner declines ISSUED LPO -> 200 DECLINED', r.status === 200 && r.data.status === 'DECLINED', r.data);
  check('RFQ back to QUOTING_CLOSED', (await db.rFQ.findUnique({ where: { id: dr.id } })).status === 'QUOTING_CLOSED');
  check('declined quote -> REJECTED; sup2 restored to SHORTLISTED; manual reject stays REJECTED',
    (await qOf('sup1')).status === 'REJECTED' && (await qOf('sup2')).status === 'SHORTLISTED' && (await qOf('sup3')).status === 'REJECTED',
    [(await qOf('sup1')).status, (await qOf('sup2')).status, (await qOf('sup3')).status]);
  check('buyer notified with reason', (await db.notification.count({ where: { companyId: 'buyer1', type: 'LPO_DECLINED', body: { contains: 'No stock' } } })) === 1);
  check('decline again -> 400', (await call('PATCH', `/lpos/${lpo1.id}/decline`, S1, {})).status === 400);
  check('re-award declined quote -> 400', (await call('POST', `/quotes/${(await qOf('sup1')).id}/award`, B1, {})).status === 400);
  check('re-award manually rejected quote -> 400', (await call('POST', `/quotes/${(await qOf('sup3')).id}/award`, B1, {})).status === 400);
  r = await call('POST', `/quotes/${(await qOf('sup2')).id}/award`, B1, {});
  check('award sup2 after decline -> 201 (second LPO for the RFQ)', r.status === 201 && (await db.lPO.count({ where: { rfqId: dr.id } })) === 2, r.data);
  const lpo2 = await db.lPO.findFirst({ where: { rfqId: dr.id, status: 'ISSUED' } });
  check('second award while LPO active -> 400', (await call('POST', `/quotes/${(await qOf('sup1')).id}/award`, B1, {})).status === 400);
  r = await call('PATCH', `/lpos/${lpo2.id}/accept`, S2);
  check('sup2 accepts -> 200 with order', r.status === 200 && !!r.data.order, r.data);
  const order1 = r.data.order;
  check('decline ACCEPTED LPO -> 400', (await call('PATCH', `/lpos/${lpo2.id}/decline`, S2, {})).status === 400);
  check('listLPOs shows declined history for sup1', (await call('GET', '/lpos', S1)).data.some((l) => l.id === lpo1.id && l.status === 'DECLINED'));

  // accept vs decline racing on the same LPO: exactly one wins
  const rr = await newRfq(100);
  await call('POST', `/rfqs/${rr.id}/quotes`, S3, { price: 10 });
  await call('POST', `/quotes/${(await db.quote.findFirst({ where: { rfqId: rr.id } })).id}/award`, B1, {});
  const lpo3 = await db.lPO.findFirst({ where: { rfqId: rr.id } });
  const race = await Promise.all([call('PATCH', `/lpos/${lpo3.id}/accept`, S3), call('PATCH', `/lpos/${lpo3.id}/decline`, S3, {})]);
  const final3 = await db.lPO.findUnique({ where: { id: lpo3.id }, include: { order: true } });
  check('accept vs decline race: one 200, consistent end state', race.filter((x) => x.status === 200).length === 1 &&
    ((final3.status === 'ACCEPTED' && final3.order) || (final3.status === 'DECLINED' && !final3.order)), { codes: race.map((x) => x.status), status: final3.status });

  // two different quotes of the same RFQ awarded at the same moment: exactly one may win
  for (let round = 1; round <= 3; round++) {
    await db.wallet.updateMany({ where: { companyId: { in: ['sup1', 'sup2'] } }, data: { balance: 100 } });
    const pa = await newRfq(100);
    await call('POST', `/rfqs/${pa.id}/quotes`, S1, { price: 50 });
    await call('POST', `/rfqs/${pa.id}/quotes`, S2, { price: 60 });
    const [qa, qb] = await db.quote.findMany({ where: { rfqId: pa.id }, orderBy: { supplierCompanyId: 'asc' } });
    const both = await Promise.all([call('POST', `/quotes/${qa.id}/award`, B1, {}), call('POST', `/quotes/${qb.id}/award`, B1, {})]);
    const lpos = await db.lPO.findMany({ where: { rfqId: pa.id } });
    const quotesAfter = await db.quote.findMany({ where: { rfqId: pa.id } });
    const codes = both.map((x) => x.status).sort();
    check(`parallel award of two quotes (round ${round}): one 201 + one 400, 1 LPO, 1 AWARDED quote, RFQ AWARDED`,
      codes.join() === '201,400' && lpos.length === 1 &&
      quotesAfter.filter((q) => q.status === 'AWARDED').length === 1 &&
      quotesAfter.filter((q) => q.status === 'REJECTED').length === 1 &&
      lpos[0].quoteId === quotesAfter.find((q) => q.status === 'AWARDED').id &&
      (await db.rFQ.findUnique({ where: { id: pa.id } })).status === 'AWARDED',
      { codes, lpos: lpos.length, quotes: quotesAfter.map((q) => q.status) });
  }

  console.log('\n== 10. M6 order state machine ==');
  const st = (tokn, status) => call('PATCH', `/orders/${order1.id}/status`, tokn, { status });
  const ordStatus = async () => (await db.order.findUnique({ where: { id: order1.id } })).status;
  check('invalid status value -> 400', (await st(S2, 'FOO')).status === 400);
  check('supplier CONFIRMED -> COMPLETED by hand -> 400', (await st(S2, 'COMPLETED')).status === 400);
  check('supplier CONFIRMED -> DELIVERED (skip) -> 400', (await st(S2, 'DELIVERED')).status === 400);
  check('buyer cannot move lifecycle -> 400', (await st(B1, 'IN_PROGRESS')).status === 400);
  check('outsider -> 403', (await st(S1, 'IN_PROGRESS')).status === 403);
  check('supplier CONFIRMED -> IN_PROGRESS -> 200', (await st(S2, 'IN_PROGRESS')).status === 200 && (await ordStatus()) === 'IN_PROGRESS');
  check('buyer raises dispute -> 200', (await st(B1, 'DISPUTED')).status === 200 && (await ordStatus()) === 'DISPUTED');
  check('supplier cannot move a disputed order -> 400', (await st(S2, 'SHIPPED')).status === 400);
  check('delivery update on disputed order -> 400', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'DISPATCHED' })).status === 400);
  check('admin cannot move orders via PATCH /status -> 400', (await st(ADM, 'IN_PROGRESS')).status === 400 && (await ordStatus()) === 'DISPUTED');
  check('admin resumes the dispute -> 200, back to IN_PROGRESS',
    (await call('POST', `/admin/orders/${order1.id}/resolve-dispute`, ADM, { action: 'RESUME', comment: 'ok' })).status === 200 && (await ordStatus()) === 'IN_PROGRESS');
  check('delivery invalid status -> 400', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'LOST' })).status === 400);
  check('delivery PENDING -> DELIVERED (skip) -> 400', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'DELIVERED' })).status === 400);
  check('delivery -> DISPATCHED -> 200, order SHIPPED', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'DISPATCHED', trackingInfo: 'TRK1' })).status === 200 && (await ordStatus()) === 'SHIPPED');
  check('tracking-only update -> 200', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { trackingInfo: 'TRK2' })).status === 200);
  check('delivery -> DELIVERED -> 200, order DELIVERED', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'DELIVERED' })).status === 200 && (await ordStatus()) === 'DELIVERED');
  check('delivery backwards DELIVERED -> DISPATCHED -> 400', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'DISPATCHED' })).status === 400);
  const inv1 = await db.invoice.findUnique({ where: { orderId: order1.id } });
  r = await call('POST', `/invoices/${inv1.id}/payments`, B1, { amount: Number(inv1.amount), method: 'bank_transfer' });
  check('payment before receipt -> 400', r.status === 400 && /confirm receipt/.test(r.data.error), r.data);
  check('buyer confirms receipt -> 200, order stays DELIVERED', (await call('POST', `/orders/${order1.id}/receipt`, B1, {})).status === 200 && (await ordStatus()) === 'DELIVERED');
  r = await call('POST', `/invoices/${inv1.id}/payments`, B1, { amount: Number(inv1.amount), method: 'bank_transfer' });
  check('full payment reported -> 201 PENDING, order not completed yet', r.status === 201 && r.data.payment.status === 'PENDING' && (await ordStatus()) === 'DELIVERED', r.data);
  check('supplier confirms -> order COMPLETED', (await call('PATCH', `/payments/${r.data.payment.id}/confirm`, S2, {})).status === 200 && (await ordStatus()) === 'COMPLETED');
  check('supplier cannot cancel COMPLETED -> 400', (await st(S2, 'CANCELLED')).status === 400);
  check('buyer cannot dispute COMPLETED -> 400', (await st(B1, 'DISPUTED')).status === 400);
  if (final3.status === 'ACCEPTED') {
    const o3 = final3.order;
    check('supplier cancels CONFIRMED unpaid order -> 200', (await call('PATCH', `/orders/${o3.id}/status`, S3, { status: 'CANCELLED' })).status === 200);
    const inv3 = await db.invoice.findUnique({ where: { orderId: o3.id } });
    check('payment on cancelled order -> 400', (await call('POST', `/invoices/${inv3.id}/payments`, B1, { amount: 1 })).status === 400);
  }

  console.log('\n== 11. C6/M10/M14 payments: report -> supplier confirms/rejects ==');
  // helper: RFQ -> quote by sup -> award -> accept, returns { order, invoice };
  // received: also dispatch and confirm receipt, so the invoice is payable
  async function makeOrder(price, supTok, supId, buyerTok = B1, { received = false } = {}) {
    await db.wallet.update({ where: { companyId: supId }, data: { balance: 1000 } });
    const rf = (await call('POST', '/rfqs', buyerTok, { title: 'Pay ' + price, description: 'x', budget: 100, deadline: future(), publish: true })).data;
    await call('POST', `/rfqs/${rf.id}/quotes`, supTok, { price });
    const q = await db.quote.findFirst({ where: { rfqId: rf.id } });
    await call('POST', `/quotes/${q.id}/award`, buyerTok, {});
    const l = await db.lPO.findFirst({ where: { rfqId: rf.id } });
    const acc = await call('PATCH', `/lpos/${l.id}/accept`, supTok);
    if (received) {
      await call('PATCH', `/orders/${acc.data.order.id}/delivery`, supTok, { status: 'DISPATCHED' });
      const rc = await call('POST', `/orders/${acc.data.order.id}/receipt`, buyerTok, {});
      if (rc.status !== 200) throw new Error('makeOrder: receipt failed ' + JSON.stringify(rc.data));
    }
    return { order: acc.data.order, invoice: await db.invoice.findUnique({ where: { orderId: acc.data.order.id } }), rfq: rf };
  }
  // payments reported before receipt was required (data from before that rule): created directly
  const legacyPayment = (invoiceId, amount, status = 'PENDING') => db.payment.create({ data: { invoiceId, amount, method: 'cash', status,
    ...(status === 'COMPLETED' ? { decidedAt: new Date(), paidAt: new Date() } : {}) } });
  const { order: po, invoice: pinv } = await makeOrder(100, S2, 'sup2', B1, { received: true });
  const pay = (body, tokn = B1) => call('POST', `/invoices/${pinv.id}/payments`, tokn, body);
  const invNow = async () => db.invoice.findUnique({ where: { id: pinv.id } });
  const poStatus = async () => (await db.order.findUnique({ where: { id: po.id } })).status;
  for (const [bad, why] of [[{ amount: -5, method: 'cash' }, 'negative'], [{ amount: 0, method: 'cash' }, 'zero'], [{ amount: '50', method: 'cash' }, 'string'],
    [{ amount: 10.0001, method: 'cash' }, '4 decimals'], [{ amount: 10, method: 'bitcoin' }, 'bad method'], [{ amount: 10, method: 'cash', reference: 'x'.repeat(101) }, 'long reference']]) {
    check(`report payment ${why} -> 400`, (await pay(bad)).status === 400);
  }
  check('supplier cannot report a payment -> 403', (await pay({ amount: 10, method: 'cash' }, S2)).status === 403);
  check('other buyer -> 403', (await pay({ amount: 10, method: 'cash' }, B2)).status === 403);
  r = await pay({ amount: 150, method: 'cash' });
  check('amount above outstanding 100 -> 400', r.status === 400 && /100\.00/.test(r.data.error), r.data);
  r = await pay({ amount: 40, method: 'bank_transfer', reference: 'BBK-1' });
  const p40 = r.data.payment;
  check('report 40 -> 201 PENDING with reference; invoice still ISSUED', r.status === 201 && p40.status === 'PENDING' && p40.reference === 'BBK-1' && (await invNow()).status === 'ISSUED', r.data);
  check('pending counts against outstanding: 70 -> 400', (await pay({ amount: 70, method: 'cash' })).status === 400);
  const p60 = (await pay({ amount: 60, method: 'cheque', reference: 'CHQ-9' })).data.payment;
  r = await pay({ amount: 1, method: 'cash' });
  check('nothing left while rest is pending -> 400', r.status === 400 && /awaiting/.test(r.data.error), r.data);
  check('buyer cannot confirm -> 403', (await call('PATCH', `/payments/${p40.id}/confirm`, B1, {})).status === 403);
  check('other supplier cannot confirm -> 403', (await call('PATCH', `/payments/${p40.id}/confirm`, S1, {})).status === 403);
  r = await call('PATCH', `/payments/${p60.id}/reject`, S2, { reason: 'Cheque bounced' });
  check('supplier rejects 60 -> FAILED with reason; invoice still ISSUED', r.status === 200 && r.data.status === 'FAILED' && r.data.rejectReason === 'Cheque bounced' && (await invNow()).status === 'ISSUED', r.data);
  check('reject again -> 400', (await call('PATCH', `/payments/${p60.id}/reject`, S2, {})).status === 400);
  check('confirm a rejected payment -> 400', (await call('PATCH', `/payments/${p60.id}/confirm`, S2, {})).status === 400);
  check('buyer notified of rejection', (await db.notification.count({ where: { companyId: 'buyer1', type: 'PAYMENT_REJECTED', body: { contains: 'Cheque bounced' } } })) === 1);
  r = await call('PATCH', `/payments/${p40.id}/confirm`, S2, {});
  check('confirm 40 -> invoice PARTIALLY_PAID, order not completed', r.status === 200 && r.data.invoice.status === 'PARTIALLY_PAID' && (await poStatus()) === 'DELIVERED', r.data.invoice);

  // M10: three parallel reports of 30 with 60 outstanding -> exactly two accepted
  const par = await Promise.all([1, 2, 3].map(() => pay({ amount: 30, method: 'cash' })));
  const pcodes = par.map((x) => x.status).sort();
  const pend = await db.payment.aggregate({ where: { invoiceId: pinv.id, status: 'PENDING' }, _sum: { amount: true } });
  check('3 parallel reports of 30 (60 open) -> 201,201,400 and pending = 60', pcodes.join() === '201,201,400' && Number(pend._sum.amount) === 60, { pcodes, pending: pend._sum.amount });
  const ids = par.filter((x) => x.status === 201).map((x) => x.data.payment.id);
  const conf = await Promise.all(ids.map((id) => call('PATCH', `/payments/${id}/confirm`, S2, {})));
  const invEnd = await invNow();
  const paidSum = await db.payment.aggregate({ where: { invoiceId: pinv.id, status: 'COMPLETED' }, _sum: { amount: true } });
  check('parallel confirms -> both 200, paid 100, invoice PAID, order COMPLETED', conf.every((x) => x.status === 200) && Number(paidSum._sum.amount) === 100 && invEnd.status === 'PAID' && (await poStatus()) === 'COMPLETED', { codes: conf.map((x) => x.status), paid: paidSum._sum.amount, inv: invEnd.status });
  r = await pay({ amount: 1, method: 'cash' });
  check('pay a PAID invoice -> 400', r.status === 400 && /already paid/.test(r.data.error), r.data);

  // order cancelled with a (pre-rule) pending payment -> payment FAILED, invoice CANCELLED, no more payments
  const { order: co, invoice: cinv } = await makeOrder(50, S2, 'sup2');
  const pp = await legacyPayment(cinv.id, 20);
  check('supplier cancels order with only a pending payment -> 200', (await call('PATCH', `/orders/${co.id}/status`, S2, { status: 'CANCELLED' })).status === 200);
  const ppAfter = await db.payment.findUnique({ where: { id: pp.id } });
  check('pending payment -> FAILED "Order cancelled", invoice CANCELLED', ppAfter.status === 'FAILED' && ppAfter.rejectReason === 'Order cancelled' && (await db.invoice.findUnique({ where: { id: cinv.id } })).status === 'CANCELLED');
  check('pay a CANCELLED invoice -> 400', (await call('POST', `/invoices/${cinv.id}/payments`, B1, { amount: 5, method: 'cash' })).status === 400);
  check('confirm payment of cancelled invoice -> 400', (await call('PATCH', `/payments/${pp.id}/confirm`, S2, {})).status === 400);
  const { order: ko, invoice: kinv } = await makeOrder(50, S2, 'sup2');
  const kp = await legacyPayment(kinv.id, 10);
  check('supplier can still confirm a payment reported before receipt -> 200', (await call('PATCH', `/payments/${kp.id}/confirm`, S2, {})).status === 200);
  check('supplier cannot cancel order with a confirmed payment -> 400', (await call('PATCH', `/orders/${ko.id}/status`, S2, { status: 'CANCELLED' })).status === 400);

  console.log('\n== 12. BHD fils: 3 decimals everywhere ==');
  // fee = 5% of budget rounded half-up to 3 decimals: 333.333 * 0.05 = 16.66665 -> 16.667
  await db.wallet.update({ where: { companyId: 'sup1' }, data: { balance: 100 } });
  const fr = await newRfq(333.333);
  check('RFQ budget with 3 decimals stored exactly', fr && Number(fr.budget) === 333.333 && fr.budget === '333.333', fr && fr.budget);
  check('quote with 3-decimal price -> 201', (await call('POST', `/rfqs/${fr.id}/quotes`, S1, { price: 250.125 })).status === 201);
  const feeTx = await db.walletTransaction.findFirst({ where: { reference: `RFQ ${fr.id}`, type: 'BID_DEBIT' }, include: { wallet: true } });
  check('bid fee 16.667 (half-up), balance 83.333, ledger matches', feeTx.amount.toString() === '-16.667' && feeTx.wallet.balance.toString() === '83.333', { fee: feeTx.amount.toString(), balance: feeTx.wallet.balance.toString() });
  check('quote price stored exactly 250.125', (await db.quote.findFirst({ where: { rfqId: fr.id } })).price.toString() === '250.125');
  r = await call('POST', `/rfqs/${fr.id}/cancel`, B1);
  check('refund returns exactly 16.667', r.status === 200 && r.data.refunds[0].amount === '16.667' && (await bal('sup1')) === 100, r.data.refunds);
  for (const [path, body, tokn, what] of [
    ['/rfqs', { title: 'x', description: 'y', budget: 10.0005, deadline: future() }, B1, 'RFQ budget'],
    ['/catalog', { name: 'x', price: 1.2345 }, S1, 'catalog price'],
    ['/wallet/topup', { companyId: 'sup1', amount: 0.0001 }, ADM, 'top-up'],
  ]) {
    r = await call('POST', path, tokn, body);
    check(`${what} with 4 decimals -> 400`, r.status === 400 && /3 decimal/.test(r.data.error), r.data);
  }
  const fq = await newRfq(100);
  r = await call('POST', `/rfqs/${fq.id}/quotes`, S2, { price: 1.0005 });
  check('quote price with 4 decimals -> 400, no fee charged', r.status === 400 && /3 decimal/.test(r.data.error));
  check('admin top-up 0.005 (5 fils) -> 201', (await call('POST', '/wallet/topup', ADM, { companyId: 'sup3', amount: 0.005 })).status === 201);
  const { invoice: finv } = await makeOrder(12.345, S2, 'sup2', B1, { received: true });
  check('invoice amount 12.345 kept to the fils', finv.amount.toString() === '12.345');
  r = await call('POST', `/invoices/${finv.id}/payments`, B1, { amount: 12.346, method: 'benefit_pay' });
  check('1 fils over the outstanding -> 400 (outstanding 12.345)', r.status === 400 && /12\.345/.test(r.data.error), r.data);
  r = await call('POST', `/invoices/${finv.id}/payments`, B1, { amount: 12.345, method: 'benefit_pay', reference: 'BP-778812' });
  check('BenefitPay payment of 12.345 -> 201', r.status === 201 && r.data.payment.method === 'benefit_pay' && r.data.payment.amount === '12.345', r.data);
  await call('PATCH', `/payments/${r.data.payment.id}/confirm`, S2, {});
  check('confirmed 12.345 -> invoice PAID exactly', (await db.invoice.findUnique({ where: { id: finv.id } })).status === 'PAID');

  console.log('\n== 13. L7 admin delete keeps counterparties\' records ==');
  const mkCo = async (id, role, balance = 0) => db.user.create({ data: { id: 'u-' + id, email: id + '@t.test', passwordHash: await bcrypt.hash('pw123456', 4), role, emailVerified: true,
    company: { create: { id, name: 'Co ' + id, type: role, verificationStatus: 'VERIFIED', phone: '+973 1', registrationNumber: 'CR-' + id, wallet: { create: { balance } } } } } });
  await mkCo('buyer5', 'BUYER'); await mkCo('sup5', 'SUPPLIER', 1000);
  const B5 = tok('BUYER', 'buyer5'), S5 = tok('SUPPLIER', 'sup5');
  const { order: o5, invoice: i5 } = await makeOrder(80, S5, 'sup5', B5, { received: true });
  const p5 = (await call('POST', `/invoices/${i5.id}/payments`, B5, { amount: 80, method: 'bank_transfer' })).data.payment;
  await call('PATCH', `/payments/${p5.id}/confirm`, S5, {});
  await db.wallet.update({ where: { companyId: 'sup1' }, data: { balance: 100 } });
  const open5 = (await call('POST', '/rfqs', B5, { title: 'buyer5 open', description: 'x', budget: 200, deadline: future(), publish: true })).data;
  await call('POST', `/rfqs/${open5.id}/quotes`, S1, { price: 150 }); // sup1 pays 10
  r = await call('DELETE', '/admin/companies/buyer5', ADM);
  check('delete buyer5 with trading history -> anonymized', r.status === 200 && r.data.mode === 'anonymized', r.data);
  const b5 = await db.company.findUnique({ where: { id: 'buyer5' }, include: { user: true } });
  check('buyer5 anonymized + deactivated', b5 && b5.name === 'Deleted company' && !b5.isActive && b5.phone === null && b5.registrationNumber === null && b5.user.email.endsWith('@deleted.invalid') && !b5.user.isActive);
  check('order, invoice, confirmed payment kept', !!(await db.order.findUnique({ where: { id: o5.id } })) && (await db.invoice.findUnique({ where: { id: i5.id } })).status === 'PAID' && (await db.payment.findUnique({ where: { id: p5.id } })).status === 'COMPLETED');
  check('counterparty sup5 still opens the order', (await call('GET', `/orders/${o5.id}`, S5)).status === 200);
  check('sup1 refunded for buyer5 open RFQ', (await bal('sup1')) === 100 && (await db.rFQ.findUnique({ where: { id: open5.id } })).status === 'CANCELLED');
  check('deleted buyer cannot log in', (await call('POST', '/auth/login', null, { email: 'buyer5@t.test', password: 'pw123456' })).status === 401);

  await mkCo('sup6', 'SUPPLIER', 100); const S6 = tok('SUPPLIER', 'sup6');
  const r6 = await newRfq(100);
  await call('POST', `/rfqs/${r6.id}/quotes`, S6, { price: 90 });
  await call('POST', `/rfqs/${r6.id}/quotes`, S1, { price: 95 });
  await call('POST', '/catalog', S6, { name: 'sup6 item', price: 3 });
  r = await call('DELETE', '/admin/companies/sup6', ADM);
  check('delete sup6 without trading history -> deleted', r.status === 200 && r.data.mode === 'deleted', r.data);
  check('sup6 rows gone', !(await db.company.findUnique({ where: { id: 'sup6' } })) && !(await db.user.findUnique({ where: { id: 'u-sup6' } })) && (await db.catalogItem.count({ where: { name: 'sup6 item' } })) === 0);
  check('other supplier\'s quote on the same RFQ untouched', (await db.quote.count({ where: { rfqId: r6.id, supplierCompanyId: 'sup1' } })) === 1);

  console.log('\n== 14. accounts: M2 token invalidation, M18 email/password, M3 re-verification ==');
  await mkCo('sup7', 'SUPPLIER', 100);
  const login7 = async (password = 'pw123456', email = 'sup7@t.test') => call('POST', '/auth/login', null, { email, password });
  r = await login7();
  const T1 = r.data.token;
  check('login -> token; token works', r.status === 200 && (await call('GET', '/rfqs', T1)).status === 200);
  r = await call('PATCH', '/auth/password', T1, { currentPassword: 'wrong-pass', newPassword: 'newpass123' });
  check('wrong current password -> 401, session kept', r.status === 401 && (await call('GET', '/rfqs', T1)).status === 200);
  check('new password of 7 chars -> 400', (await call('PATCH', '/auth/password', T1, { currentPassword: 'pw123456', newPassword: 'short77' })).status === 400);
  r = await call('PATCH', '/auth/password', T1, { currentPassword: 'pw123456', newPassword: 'newpass123' });
  const T2 = r.data && r.data.token;
  check('change password -> 200 with a fresh token', r.status === 200 && !!T2 && T2 !== T1, r.data);
  r = await call('GET', '/rfqs', T1);
  check('old token rejected after password change', r.status === 401 && r.data.error === 'Invalid or expired token', r.data);
  check('fresh token works', (await call('GET', '/rfqs', T2)).status === 200);
  check('old password no longer logs in', (await login7('pw123456')).status === 401);

  check('forgot-password with different case/spaces -> 200', (await call('POST', '/auth/forgot-password', null, { email: '  SUP7@T.Test ' })).status === 200);
  // the DB holds only a hash (L6); take the raw token from the email, like a real user would
  await new Promise((res) => setTimeout(res, 100)); // the email is sent right after the response
  const resetMail = [...sentEmails].reverse().find((m) => m.to === 'sup7@t.test' && /reset-password.html/.test(m.html));
  const rt = resetMail && resetMail.html.match(/token=([0-9a-f]+)/)[1];
  check('reset token issued for the normalized email', !!rt);
  check('reset with 7-char password -> 400', (await call('POST', '/auth/reset-password', null, { token: rt, newPassword: 'short77' })).status === 400);
  check('reset password -> 200', (await call('POST', '/auth/reset-password', null, { token: rt, newPassword: 'resetpass9' })).status === 200);
  check('token from before the reset rejected', (await call('GET', '/rfqs', T2)).status === 401);
  r = await login7('resetpass9', 'Sup7@T.TEST');
  const T3 = r.data && r.data.token;
  check('login with new password and mixed-case email -> 200', r.status === 200);
  const tr = await call('POST', '/admin/companies/sup7/reset-password', ADM);
  check('admin reset-password -> temp password', tr.status === 200 && !!tr.data.tempPassword);
  check('token from before the admin reset rejected', (await call('GET', '/rfqs', T3)).status === 401);
  check('temp password logs in', (await login7(tr.data.tempPassword)).status === 200);

  // no Railway proxy in tests: give this section its own client IP so /register's 10-per-15-min limit
  // (already partly used by the consent tests) doesn't interfere; trust proxy 2 reads it from XFF
  const REG_FROM = { 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' };
  const regBody = (email, password = 'goodpass1') => ({ email, password, role: 'BUYER', companyName: 'Reg', consent: true });
  r = await call('POST', '/auth/register', null, regBody('  Mixed.Case@Example.COM '), undefined, REG_FROM);
  check('register with mixed case -> 201', r.status === 201, r.data);
  check('stored lowercase and trimmed', !!(await db.user.findUnique({ where: { email: 'mixed.case@example.com' } })));
  r = await call('POST', '/auth/register', null, regBody('MIXED.case@example.com'), undefined, REG_FROM);
  check('same email in other case -> 409', r.status === 409, r.data);
  for (const [email, pw, why] of [['not-an-email', 'goodpass1', 'invalid email'], ['a@b', 'goodpass1', 'email without domain dot'],
    ['ok@example.com', 'seven77', '7-char password'], ['ok@example.com', 'x'.repeat(73), '73-byte password'], ['ok@example.com', 'пароль'.repeat(7), 'long multibyte password']]) {
    r = await call('POST', '/auth/register', null, regBody(email, pw), undefined, REG_FROM);
    check(`register ${why} -> 400`, r.status === 400, r.data);
  }

  const coStatus = async (id) => (await db.company.findUnique({ where: { id } })).verificationStatus;
  await mkCo('sup8', 'SUPPLIER', 100);
  const S8 = tok('SUPPLIER', 'sup8');
  r = await call('PATCH', '/companies/me', S8, { phone: '+973 2' });
  check('verified: phone change keeps VERIFIED', r.status === 200 && r.data.reverificationRequired === false && (await coStatus('sup8')) === 'VERIFIED');
  r = await call('PATCH', '/companies/me', S8, { name: 'Co sup8', registrationNumber: ' CR-sup8 ' });
  check('verified: same name/CR (incl. spaces) keeps VERIFIED', r.status === 200 && (await coStatus('sup8')) === 'VERIFIED', r.data);
  check('empty name -> 400', (await call('PATCH', '/companies/me', S8, { name: '  ' })).status === 400);
  r = await call('PATCH', '/companies/me', S8, { name: 'Renamed Trading WLL' });
  check('verified: name change -> IN_REVIEW, flagged', r.status === 200 && r.data.reverificationRequired === true && (await coStatus('sup8')) === 'IN_REVIEW' && /Re-verification/.test(r.data.verificationNotes), r.data);
  const rv = await newRfq(100);
  check('while IN_REVIEW the supplier cannot quote', (await call('POST', `/rfqs/${rv.id}/quotes`, S8, { price: 10 })).status === 403);
  check('admin re-verifies', (await call('PATCH', '/admin/companies/sup8/verify', ADM, { status: 'VERIFIED' })).status === 200);
  r = await call('PATCH', '/companies/me', S8, { registrationNumber: 'CR-NEW-1' });
  check('verified: CR change -> IN_REVIEW', r.data.reverificationRequired === true && (await coStatus('sup8')) === 'IN_REVIEW');
  await db.company.update({ where: { id: 'sup8' }, data: { verificationStatus: 'PENDING' } });
  r = await call('PATCH', '/companies/me', S8, { name: 'Another Name' });
  check('not verified: name change keeps PENDING', r.data.reverificationRequired === false && (await coStatus('sup8')) === 'PENDING');

  console.log('\n== 15. M12 budget required to publish, M13 order rows show LPO and counterparty ==');
  const noBudget = { title: 'nb', description: 'x', deadline: future() };
  r = await call('POST', '/rfqs', B1, { ...noBudget, publish: true });
  check('publish without budget -> 400', r.status === 400 && /budget is required/.test(r.data.error), r.data);
  r = await call('POST', '/rfqs', B1, noBudget);
  check('draft without budget -> 201 DRAFT', r.status === 201 && r.data.status === 'DRAFT', r.data);
  const draftId = r.data.id;
  r = await call('PATCH', `/rfqs/${draftId}`, B1, { status: 'PUBLISHED' });
  check('publish draft that has no budget -> 400', r.status === 400 && /budget is required/.test(r.data.error), r.data);
  r = await call('PATCH', `/rfqs/${draftId}`, B1, { status: 'PUBLISHED', budget: null });
  check('publish with budget: null -> 400', r.status === 400);
  r = await call('PATCH', `/rfqs/${draftId}`, B1, { status: 'PUBLISHED', budget: 80 });
  check('publish draft with budget in the same request -> 200 PUBLISHED', r.status === 200 && r.data.status === 'PUBLISHED' && Number(r.data.budget) === 80, r.data);
  check('it can now receive a paid quote', (await call('POST', `/rfqs/${draftId}/quotes`, S1, { price: 70 })).status === 201);
  const withBudgetDraft = (await call('POST', '/rfqs', B1, { ...noBudget, budget: 50 })).data;
  check('publish a draft that already has a budget -> 200', (await call('PATCH', `/rfqs/${withBudgetDraft.id}`, B1, { status: 'PUBLISHED' })).status === 200);

  const { order: mo } = await makeOrder(20, S2, 'sup2');
  const lpoRow = await db.lPO.findFirst({ where: { order: { id: mo.id } } });
  const ordBuyerRow = (await call('GET', '/orders', B1)).data.find((o) => o.id === mo.id);
  check('buyer GET /orders: lpo.id + supplier name', ordBuyerRow && ordBuyerRow.lpo.id === lpoRow.id && ordBuyerRow.lpo.supplierCompany.name === 'Co sup2' && ordBuyerRow.lpo.buyerCompany.name === 'Co buyer1', ordBuyerRow && ordBuyerRow.lpo);
  const ordSupRow = (await call('GET', '/orders', S2)).data.find((o) => o.id === mo.id);
  check('supplier GET /orders: buyer name', ordSupRow && ordSupRow.lpo.buyerCompany.name === 'Co buyer1');
  const detail = (await call('GET', `/orders/${mo.id}`, S2)).data;
  check('GET /orders/:id includes both company names', detail.lpo.buyerCompany.name === 'Co buyer1' && detail.lpo.supplierCompany.name === 'Co sup2');
  check('company objects expose only id and name', Object.keys(ordBuyerRow.lpo.supplierCompany).sort().join() === 'id,name');
  check('other supplier cannot read the order -> 403', (await call('GET', `/orders/${mo.id}`, S1)).status === 403);

  console.log('\n== 16. M16 notify() failures are reported ==');
  const { notify } = require(path.join(root, 'src/utils/notify'));
  const before16 = sentryCaptured.length;
  let threw = false;
  try { await notify('no-such-company', 'TEST_TYPE', 'Title', 'Body', 'ord-1'); } catch (e) { threw = true; }
  const cap = sentryCaptured[sentryCaptured.length - 1];
  check('failing notify() does not throw', !threw);
  check('failing notify() is sent to Sentry with type and ids', sentryCaptured.length === before16 + 1 &&
    cap.ctx.tags.area === 'notify' && cap.ctx.tags.notificationType === 'TEST_TYPE' && cap.ctx.extra.companyId === 'no-such-company' && cap.ctx.extra.relatedOrderId === 'ord-1',
    cap && cap.ctx);
  const okBefore = sentryCaptured.length;
  await notify('buyer1', 'TEST_OK', 'ok');
  check('successful notify() creates the row and reports nothing', sentryCaptured.length === okBefore && (await db.notification.count({ where: { companyId: 'buyer1', type: 'TEST_OK' } })) === 1);

  console.log('\n== 17. M15 verification documents, L9 new-quote notification ==');
  const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 test document').toString('base64');
  const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  await mkCo('sup9', 'SUPPLIER', 100);
  await db.company.update({ where: { id: 'sup9' }, data: { verificationStatus: 'PENDING' } });
  const S9 = tok('SUPPLIER', 'sup9');
  const addDoc = (fileUrl, docType = 'TRADE_LICENSE', tokn = S9) => call('POST', '/companies/me/documents', tokn, { fileUrl, docType });
  for (const [url, why] of [['javascript:alert(1)', 'javascript: URL'], ['https://evil.example/x.pdf', 'remote link'],
    ['data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64'), 'SVG'],
    ['data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64'), 'HTML'],
    ['data:application/pdf;base64,' + 'A'.repeat(2.9 * 1024 * 1024), 'over 2MB'], [PDF + '"onerror', 'broken base64']]) {
    r = await addDoc(url);
    check(`upload ${why} -> 400`, r.status === 400, r.data);
  }
  check('unknown docType -> 400', (await addDoc(PDF, 'PASSPORT')).status === 400);
  r = await addDoc(PDF);
  check('valid PDF -> 201 without file content in response', r.status === 201 && !('fileUrl' in r.data) && r.data.docType === 'TRADE_LICENSE', r.data);
  const pdfId = r.data.id;
  check('PENDING company -> IN_REVIEW after upload', (await db.company.findUnique({ where: { id: 'sup9' } })).verificationStatus === 'IN_REVIEW');
  check('valid PNG -> 201', (await addDoc(PNG, 'CR_CERTIFICATE')).status === 201);
  check('VERIFIED company stays VERIFIED after uploading', (await addDoc(PDF, 'OTHER', S1)).status === 201 && (await db.company.findUnique({ where: { id: 'sup1' } })).verificationStatus === 'VERIFIED');
  const noContent = (docs) => Array.isArray(docs) && docs.length > 0 && docs.every((d) => !('fileUrl' in d) && d.id && d.docType && d.uploadedAt);
  check('GET /companies/me: documents without file content', noContent((await call('GET', '/companies/me', S9)).data.documents));
  check('GET /auth/me: documents without file content', noContent((await call('GET', '/auth/me', S9)).data.company.documents));
  const adminRow = (await call('GET', '/admin/companies', ADM)).data.find((x) => x.id === 'sup9');
  check('admin list: 2 documents, no file content', adminRow && adminRow.documents.length === 2 && noContent(adminRow.documents));
  r = await call('GET', `/admin/companies/sup9/documents/${pdfId}`, ADM);
  check('admin fetches one document with its file', r.status === 200 && r.data.fileUrl === PDF, r.status);
  check('document id under another company -> 404', (await call('GET', `/admin/companies/sup1/documents/${pdfId}`, ADM)).status === 404);
  check('non-admin cannot fetch documents -> 403', (await call('GET', `/admin/companies/sup9/documents/${pdfId}`, S9)).status === 403);

  await db.wallet.update({ where: { companyId: 'sup2' }, data: { balance: 100 } });
  const nq = (await call('POST', '/rfqs', B1, { title: 'Office desks', description: 'x', budget: 100, deadline: future(), publish: true })).data;
  const notesBefore = await db.notification.count({ where: { companyId: 'buyer1', type: 'NEW_QUOTE' } });
  check('supplier quotes -> 201', (await call('POST', `/rfqs/${nq.id}/quotes`, S2, { price: 64.5 })).status === 201);
  await new Promise((res) => setTimeout(res, 150)); // notify() runs right after the response
  const nqNote = await db.notification.findFirst({ where: { companyId: 'buyer1', type: 'NEW_QUOTE' }, orderBy: { createdAt: 'desc' } });
  check('buyer notified of the new quote (amount + RFQ title, no supplier name)', nqNote && nqNote.body.includes('64.500 BHD') && nqNote.body.includes('Office desks') && !nqNote.body.includes('Co sup2'), nqNote && nqNote.body);
  check('rejected duplicate quote sends no notification', (await call('POST', `/rfqs/${nq.id}/quotes`, S2, { price: 60 })).status === 409 &&
    (await db.notification.count({ where: { companyId: 'buyer1', type: 'NEW_QUOTE' } })) === notesBefore + 1);

  console.log('\n== 18. L5 login order/timing, L6 hashed reset tokens, L8 startup checks ==');
  // own client IP: authLimiter allows 10 failed logins per 15 min and earlier sections used some
  const FROM = { 'X-Forwarded-For': '198.51.100.9, 10.0.0.1' };
  const loginAs = (email, password) => call('POST', '/auth/login', null, { email, password }, undefined, FROM);
  await db.user.create({ data: { id: 'u-unv', email: 'unverified@t.test', passwordHash: await bcrypt.hash('pw123456', 10), role: 'BUYER', emailVerified: false,
    company: { create: { id: 'unv', name: 'Unverified Co', type: 'BUYER', wallet: { create: { balance: 0 } } } } } });
  r = await loginAs('unverified@t.test', 'wrong-password');
  check('unverified + wrong password -> 401 Invalid credentials (no hint)', r.status === 401 && r.data.error === 'Invalid credentials', r.data);
  r = await loginAs('unverified@t.test', 'pw123456');
  check('unverified + correct password -> 403 verify email', r.status === 403 && /verify your email/.test(r.data.error), r.data);
  r = await loginAs('nobody@t.test', 'pw123456');
  check('unknown email -> 401 Invalid credentials', r.status === 401 && r.data.error === 'Invalid credentials');
  const timeLogin = async (email) => { const t0 = Date.now(); await loginAs(email, 'wrong-password'); return Date.now() - t0; };
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const tUnknown = [], tKnown = [];
  for (let i = 0; i < 3; i++) { tUnknown.push(await timeLogin('nobody' + i + '@t.test')); tKnown.push(await timeLogin('unverified@t.test')); }
  check('unknown email takes about as long as a wrong password (bcrypt runs either way)', median(tUnknown) > median(tKnown) * 0.5, { unknownMs: tUnknown, knownMs: tKnown });

  sentEmails.length = 0;
  emailDelayMs = 1500;
  const forgotStart = Date.now();
  r = await call('POST', '/auth/forgot-password', null, { email: 'unverified@t.test' });
  const forgotMs = Date.now() - forgotStart;
  check('forgot-password answers before the (slow) email is sent', r.status === 200 && forgotMs < 1000, { forgotMs });
  await new Promise((res) => setTimeout(res, 1700));
  emailDelayMs = 0;
  const mail = sentEmails.find((m) => /reset-password\.html\?token=/.test(m.html));
  const rawToken = mail && mail.html.match(/token=([0-9a-f]+)/)[1];
  const stored = (await db.user.findUnique({ where: { id: 'u-unv' } })).resetToken;
  check('reset email sent with a raw token', !!rawToken && rawToken.length === 64);
  check('database stores a SHA-256 hash, not the token', stored && stored !== rawToken && /^[0-9a-f]{64}$/.test(stored) &&
    stored === require('crypto').createHash('sha256').update(rawToken).digest('hex'));
  check('the stored hash does not work as a token', (await call('POST', '/auth/reset-password', null, { token: stored, newPassword: 'newpass123' })).status === 400);
  check('non-string token -> 400', (await call('POST', '/auth/reset-password', null, { token: { $ne: null }, newPassword: 'newpass123' })).status === 400);
  check('the emailed token resets the password', (await call('POST', '/auth/reset-password', null, { token: rawToken, newPassword: 'newpass123' })).status === 200);
  check('token is single-use', (await call('POST', '/auth/reset-password', null, { token: rawToken, newPassword: 'another123' })).status === 400);

  const { spawn } = require('child_process');
  const startApp = (env, waitMs) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', "require('./src/index.js')"], { cwd: root, env: { ...process.env, PORT: '0', ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 'running', out }); }, waitMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
  let boot = await startApp({ JWT_SECRET: '' }, 8000);
  check('no JWT_SECRET -> server refuses to start (exit 1)', boot.code === 1 && /FATAL: JWT_SECRET is not set/.test(boot.out), boot);
  boot = await startApp({ JWT_SECRET: 'short-secret' }, 4000);
  check('weak JWT_SECRET -> starts, with a loud warning', boot.code === 'running' && /WARNING: JWT_SECRET is weak/.test(boot.out) && /SENTRY_DSN is not set/.test(boot.out), boot.out.slice(0, 300));
  boot = await startApp({ JWT_SECRET: 'change_this_to_a_long_random_secret' }, 4000);
  check('.env.example placeholder secret -> warning', /WARNING: JWT_SECRET is weak/.test(boot.out));
  const src = require('fs').readFileSync(path.join(root, 'src/index.js'), 'utf8');
  check('no Sentry DSN hardcoded in the source', !/ingest\.[a-z.]*sentry\.io/.test(src));

  console.log('\n== 18b. L2 Quote.currency is BHD only ==');
  await db.wallet.updateMany({ where: { companyId: { in: ['sup1', 'sup2'] } }, data: { balance: 100 } });
  const cq = await newRfq(100);
  r = await call('POST', `/rfqs/${cq.id}/quotes`, S1, { price: 10, currency: 'USD' });
  check('quote in USD -> 400 Only BHD is supported, no fee charged', r.status === 400 && r.data.error === 'Only BHD is supported' && (await bal('sup1')) === 100, r.data);
  r = await call('POST', `/rfqs/${cq.id}/quotes`, S1, { price: 10, currency: 'BHD' });
  check('quote in BHD -> 201, stored as BHD', r.status === 201 && r.data.currency === 'BHD', r.data);
  r = await call('POST', `/rfqs/${cq.id}/quotes`, S2, { price: 11 });
  check('quote without currency -> 201, stored as BHD', r.status === 201 && r.data.currency === 'BHD');
  let checkRejects = false;
  try { await db.$executeRawUnsafe(`UPDATE "Quote" SET currency = 'USD' WHERE id = '${r.data.id}'`); } catch (e) { checkRejects = /Quote_currency_bhd_check/.test(e.message); }
  check('database itself refuses a non-BHD currency (CHECK constraint)', checkRejects);

  console.log('\n== 18c. M7 shortlist/reject respect quote and RFQ status ==');
  await db.wallet.updateMany({ where: { companyId: { in: ['sup1', 'sup2', 'sup3'] } }, data: { balance: 100 } });
  const sl = (id, tokn = B1) => call('PATCH', `/quotes/${id}/shortlist`, tokn);
  const rj = (id, tokn = B1) => call('PATCH', `/quotes/${id}/reject`, tokn);
  const qStatus = async (id) => (await db.quote.findUnique({ where: { id } })).status;
  const threeQuotes = async () => {
    const rf = await newRfq(100);
    for (const [s, price] of [[S1, 50], [S2, 60], [S3, 70]]) await call('POST', `/rfqs/${rf.id}/quotes`, s, { price });
    const qs = await db.quote.findMany({ where: { rfqId: rf.id }, orderBy: { price: 'asc' } });
    return { rfq: rf, q1: qs[0].id, q2: qs[1].id, q3: qs[2].id };
  };

  // PUBLISHED RFQ: normal transitions
  let m7 = await threeQuotes();
  r = await sl(m7.q1);
  check('shortlist SUBMITTED on PUBLISHED RFQ -> 200 SHORTLISTED', r.status === 200 && r.data.status === 'SHORTLISTED', r.data);
  check('shortlist again -> 200, unchanged (idempotent)', (await sl(m7.q1)).status === 200 && (await qStatus(m7.q1)) === 'SHORTLISTED');
  check('reject SUBMITTED -> 200 REJECTED', (await rj(m7.q2)).status === 200 && (await qStatus(m7.q2)) === 'REJECTED');
  check('reject again -> 200, unchanged (idempotent)', (await rj(m7.q2)).status === 200 && (await qStatus(m7.q2)) === 'REJECTED');
  r = await sl(m7.q2);
  check('shortlist a REJECTED quote -> 400', r.status === 400 && /REJECTED quote/.test(r.data.error) && (await qStatus(m7.q2)) === 'REJECTED', r.data);
  check('reject a SHORTLISTED quote -> 200', (await rj(m7.q1)).status === 200 && (await qStatus(m7.q1)) === 'REJECTED');
  await db.quote.update({ where: { id: m7.q3 }, data: { status: 'WITHDRAWN' } });
  check('shortlist a WITHDRAWN quote -> 400', (await sl(m7.q3)).status === 400 && (await qStatus(m7.q3)) === 'WITHDRAWN');
  check('reject a WITHDRAWN quote -> 400', (await rj(m7.q3)).status === 400 && (await qStatus(m7.q3)) === 'WITHDRAWN');
  check('other buyer -> 403', (await sl(m7.q1, B2)).status === 403 && (await rj(m7.q1, B2)).status === 403);
  check('supplier (own quote) -> 403', (await sl(m7.q1, S1)).status === 403 && (await rj(m7.q1, S1)).status === 403);
  check('unknown quote -> 404', (await sl('00000000-0000-0000-0000-000000000000')).status === 404);

  // AWARDED quote / AWARDED RFQ: nothing can be changed any more
  m7 = await threeQuotes();
  await sl(m7.q2);
  check('award q1 -> 201', (await call('POST', `/quotes/${m7.q1}/award`, B1, {})).status === 201);
  r = await rj(m7.q1);
  check('reject the AWARDED quote -> 400, stays AWARDED', r.status === 400 && (await qStatus(m7.q1)) === 'AWARDED', r.data);
  check('shortlist the AWARDED quote -> 400, stays AWARDED', (await sl(m7.q1)).status === 400 && (await qStatus(m7.q1)) === 'AWARDED');
  check('LPO of the awarded quote untouched', (await db.lPO.findFirst({ where: { quoteId: m7.q1 } })).status === 'ISSUED');
  await db.quote.update({ where: { id: m7.q2 }, data: { status: 'SUBMITTED' } }); // even a still-open quote...
  r = await sl(m7.q2);
  check('...on an AWARDED RFQ cannot be shortlisted -> 400 (RFQ status)', r.status === 400 && /RFQ in AWARDED/.test(r.data.error), r.data);
  check('...nor rejected -> 400', (await rj(m7.q2)).status === 400 && (await qStatus(m7.q2)) === 'SUBMITTED');

  // CANCELLED RFQ
  m7 = await threeQuotes();
  check('cancel RFQ -> 200', (await call('POST', `/rfqs/${m7.rfq.id}/cancel`, B1)).status === 200);
  await db.quote.update({ where: { id: m7.q1 }, data: { status: 'SUBMITTED' } }); // isolate the RFQ-status check
  r = await sl(m7.q1);
  check('shortlist on a CANCELLED RFQ -> 400', r.status === 400 && /RFQ in CANCELLED/.test(r.data.error), r.data);
  check('reject on a CANCELLED RFQ -> 400', (await rj(m7.q1)).status === 400 && (await qStatus(m7.q1)) === 'SUBMITTED');

  // QUOTING_CLOSED: bidding closed, buyer still evaluating -> allowed
  m7 = await threeQuotes();
  check('close quoting -> 200', (await call('PATCH', `/rfqs/${m7.rfq.id}`, B1, { status: 'QUOTING_CLOSED' })).status === 200);
  check('shortlist on QUOTING_CLOSED -> 200', (await sl(m7.q1)).status === 200 && (await qStatus(m7.q1)) === 'SHORTLISTED');
  check('reject on QUOTING_CLOSED -> 200', (await rj(m7.q2)).status === 200 && (await qStatus(m7.q2)) === 'REJECTED');

  // award and reject of the same quote at the same time: exactly one wins, state stays consistent
  // alternate which request is sent first, so both outcomes get exercised
  const raceOutcomes = [];
  for (let round = 1; round <= 6; round++) {
    m7 = await threeQuotes();
    const award = () => call('POST', `/quotes/${m7.q1}/award`, B1, {});
    const [aw, rjr] = round % 2 ? await Promise.all([award(), rj(m7.q1)]) : (await Promise.all([rj(m7.q1), award()])).reverse();
    const st1 = await qStatus(m7.q1);
    const lpo = await db.lPO.findFirst({ where: { quoteId: m7.q1 } });
    const consistent = (aw.status === 201 && rjr.status === 400 && st1 === 'AWARDED' && !!lpo) || (aw.status === 400 && rjr.status === 200 && st1 === 'REJECTED' && !lpo);
    raceOutcomes.push(st1);
    check(`award vs reject race (round ${round}): exactly one wins, consistent`, consistent, { award: aw.status, reject: rjr.status, quote: st1, lpo: !!lpo });
  }
  console.log('race winners:', raceOutcomes.join(', '));

  console.log('\n== 18c2. L9 supplier notified of shortlist / rejection ==');
  const settle = () => new Promise((res) => setTimeout(res, 150)); // notify() runs right after the response
  const noteCount = (companyId, type, title) => db.notification.count({ where: { companyId, type, body: { contains: '"' + title + '"' } } });
  const titled = async (title) => {
    const rf = await newRfq(100, { title });
    for (const [s, price] of [[S1, 50], [S2, 60], [S3, 70]]) await call('POST', `/rfqs/${rf.id}/quotes`, s, { price });
    const qs = await db.quote.findMany({ where: { rfqId: rf.id }, orderBy: { price: 'asc' } });
    return { q1: qs[0].id, q2: qs[1].id, q3: qs[2].id };
  };
  let nt = await titled('L9 notify A');
  await sl(nt.q1); await sl(nt.q1); await rj(nt.q2); await rj(nt.q2);
  await settle();
  check('shortlist notifies the supplier once (repeat sends nothing)', (await noteCount('sup1', 'QUOTE_SHORTLISTED', 'L9 notify A')) === 1);
  check('reject notifies the supplier once (repeat sends nothing)', (await noteCount('sup2', 'QUOTE_REJECTED', 'L9 notify A')) === 1);
  const slNote = await db.notification.findFirst({ where: { companyId: 'sup1', type: 'QUOTE_SHORTLISTED', body: { contains: 'L9 notify A' } } });
  check('notification does not name the buyer (M4)', !/Co buyer1/.test(slNote.title + slNote.body), slNote);
  check('failed transition sends nothing', (await sl(nt.q2)).status === 400 && (await settle(), await noteCount('sup2', 'QUOTE_SHORTLISTED', 'L9 notify A')) === 0);
  check('other buyer / supplier attempts send nothing', (await rj(nt.q3, B2)).status === 403 && (await rj(nt.q3, S3)).status === 403 &&
    (await settle(), await noteCount('sup3', 'QUOTE_REJECTED', 'L9 notify A')) === 0);

  nt = await titled('L9 notify B');
  await sl(nt.q2); await rj(nt.q3); await settle();
  check('award -> 201', (await call('POST', `/quotes/${nt.q1}/award`, B1, {})).status === 201);
  await settle();
  check('auto-rejected (shortlisted) loser notified on award', (await noteCount('sup2', 'QUOTE_REJECTED', 'L9 notify B')) === 1);
  check('already-rejected quote is not notified twice', (await noteCount('sup3', 'QUOTE_REJECTED', 'L9 notify B')) === 1);
  check('winner gets AWARDED, not QUOTE_REJECTED', (await noteCount('sup1', 'AWARDED', 'L9 notify B')) === 1 && (await noteCount('sup1', 'QUOTE_REJECTED', 'L9 notify B')) === 0);

  console.log('\n== 18c3. L9 disputes: buyer opens with a reason, admin resumes or cancels ==');
  const resolve = (id, body, tokn = ADM) => call('POST', `/admin/orders/${id}/resolve-dispute`, tokn, body);
  const dispute = (id, body, tokn = B1) => call('PATCH', `/orders/${id}/status`, tokn, { status: 'DISPUTED', ...body });
  const ordOf = (id) => db.order.findUnique({ where: { id } });
  const notesOf = (companyId, type, orderId) => db.notification.findMany({ where: { companyId, type, relatedOrderId: orderId } });

  // open with a reason; delivery dispatched first, so the order is SHIPPED
  let dd = await makeOrder(80, S2, 'sup2');
  await call('PATCH', `/orders/${dd.order.id}/delivery`, S2, { status: 'DISPATCHED' });
  check('reason over 1000 chars -> 400', (await dispute(dd.order.id, { reason: 'x'.repeat(1001) })).status === 400 && (await ordOf(dd.order.id)).status === 'SHIPPED');
  check('supplier cannot open a dispute -> 400', (await dispute(dd.order.id, { reason: 'no' }, S2)).status === 400);
  r = await dispute(dd.order.id, { reason: '  Goods damaged on arrival  ' });
  let o = await ordOf(dd.order.id);
  check('buyer opens dispute with reason -> 200, remembers SHIPPED', r.status === 200 && o.status === 'DISPUTED' && o.statusBeforeDispute === 'SHIPPED', o);
  let msgs = await db.message.findMany({ where: { orderId: dd.order.id } });
  check('reason written to the order chat by the buyer', msgs.length === 1 && msgs[0].senderCompanyId === 'buyer1' && msgs[0].body === 'Dispute opened: Goods damaged on arrival', msgs);
  await settle();
  check('supplier notified with the reason', (await notesOf('sup2', 'ORDER_STATUS', dd.order.id)).some((n) => n.title === 'Order disputed' && n.body === 'Reason: Goods damaged on arrival'));

  // admin list and chat access
  r = await call('GET', '/admin/orders?status=DISPUTED', ADM);
  const listed = r.status === 200 && r.data.find((x) => x.id === dd.order.id);
  check('admin lists disputed orders with reason and both parties', !!listed && listed.disputeReason === 'Goods damaged on arrival' &&
    listed.lpo.buyerCompany.name === 'Co buyer1' && listed.lpo.supplierCompany.name === 'Co sup2' && r.data.every((x) => x.status === 'DISPUTED'), listed);
  check('admin list: invalid status -> 400', (await call('GET', '/admin/orders?status=FOO', ADM)).status === 400);
  check('admin list: buyer / supplier -> 403', (await call('GET', '/admin/orders', B1)).status === 403 && (await call('GET', '/admin/orders', S2)).status === 403);
  r = await call('GET', `/orders/${dd.order.id}/messages`, ADM);
  check('admin reads the order chat -> 200', r.status === 200 && r.data.length === 1, r.data);
  check('admin cannot post to the chat directly -> 403', (await call('POST', `/orders/${dd.order.id}/messages`, ADM, { body: 'hi' })).status === 403);
  check('outsider still cannot read the chat -> 403', (await call('GET', `/orders/${dd.order.id}/messages`, S1)).status === 403);

  // resolve: validation and access
  check('resolve: bad action -> 400', (await resolve(dd.order.id, { action: 'COMPLETE', comment: 'x' })).status === 400);
  check('resolve: missing / blank comment -> 400', (await resolve(dd.order.id, { action: 'RESUME' })).status === 400 && (await resolve(dd.order.id, { action: 'RESUME', comment: '   ' })).status === 400);
  check('resolve: comment over 1000 chars -> 400', (await resolve(dd.order.id, { action: 'RESUME', comment: 'x'.repeat(1001) })).status === 400);
  check('resolve: buyer / supplier -> 403', (await resolve(dd.order.id, { action: 'RESUME', comment: 'x' }, B1)).status === 403 && (await resolve(dd.order.id, { action: 'CANCEL', comment: 'x' }, S2)).status === 403);
  check('resolve: unknown order -> 404', (await resolve('00000000-0000-0000-0000-000000000000', { action: 'RESUME', comment: 'x' })).status === 404);
  check('...order still DISPUTED after rejected attempts', (await ordOf(dd.order.id)).status === 'DISPUTED');

  // RESUME -> back to SHIPPED
  r = await resolve(dd.order.id, { action: 'RESUME', comment: ' Supplier will replace the damaged units ' });
  o = await ordOf(dd.order.id);
  check('RESUME -> 200, back to SHIPPED, remembered status cleared', r.status === 200 && o.status === 'SHIPPED' && o.statusBeforeDispute === null, o);
  msgs = await db.message.findMany({ where: { orderId: dd.order.id }, orderBy: { createdAt: 'asc' } });
  check('admin comment in chat without a sender company', msgs.length === 2 && msgs[1].senderCompanyId === null &&
    msgs[1].body === 'Dispute resolved — order resumed (shipped): Supplier will replace the damaged units', msgs[1]);
  r = await call('GET', `/orders/${dd.order.id}/messages`, B1);
  check('parties see the admin comment (senderCompany null)', r.status === 200 && r.data.length === 2 && r.data[1].senderCompany === null);
  await settle();
  check('both parties notified of the resolution', (await notesOf('buyer1', 'DISPUTE_RESOLVED', dd.order.id)).length === 1 && (await notesOf('sup2', 'DISPUTE_RESOLVED', dd.order.id)).length === 1 &&
    (await notesOf('sup2', 'DISPUTE_RESOLVED', dd.order.id))[0].body === 'Supplier will replace the damaged units');
  check('resolving again -> 400 (not DISPUTED)', (await resolve(dd.order.id, { action: 'CANCEL', comment: 'x' })).status === 400 && (await ordOf(dd.order.id)).status === 'SHIPPED');
  check('supplier can continue delivery after resume', (await call('PATCH', `/orders/${dd.order.id}/delivery`, S2, { status: 'DELIVERED' })).status === 200 && (await ordOf(dd.order.id)).status === 'DELIVERED');

  // dispute without a reason: no chat message, reason null
  dd = await makeOrder(40, S2, 'sup2');
  check('dispute without reason -> 200', (await dispute(dd.order.id, {})).status === 200);
  check('...no chat message written', (await db.message.count({ where: { orderId: dd.order.id } })) === 0);
  r = await call('GET', '/admin/orders?status=DISPUTED', ADM);
  check('...admin list shows reason null', r.data.find((x) => x.id === dd.order.id).disputeReason === null);
  // a pre-rule payment fully paying the invoice during the dispute: order stays DISPUTED; RESUME goes back
  // to the pre-dispute status (not COMPLETED — the goods aren't received); receipt then completes it
  const inv = await db.invoice.findUnique({ where: { orderId: dd.order.id } });
  const lp = await legacyPayment(inv.id, inv.amount);
  await call('PATCH', `/payments/${lp.id}/confirm`, S2, {});
  check('payment confirmed during dispute keeps the order DISPUTED', (await ordOf(dd.order.id)).status === 'DISPUTED' && (await db.invoice.findUnique({ where: { id: inv.id } })).status === 'PAID');
  check('RESUME of a paid, not received order -> back to CONFIRMED, not COMPLETED', (await resolve(dd.order.id, { action: 'RESUME', comment: 'Paid, go on' })).status === 200 && (await ordOf(dd.order.id)).status === 'CONFIRMED');
  await call('PATCH', `/orders/${dd.order.id}/delivery`, S2, { status: 'DISPATCHED' });
  check('...receipt of the paid order -> COMPLETED', (await call('POST', `/orders/${dd.order.id}/receipt`, B1, {})).status === 200 && (await ordOf(dd.order.id)).status === 'COMPLETED');

  // CANCEL: (pre-rule) pending payment fails, invoice without confirmed money is cancelled
  dd = await makeOrder(60, S2, 'sup2');
  const pendingId = (await legacyPayment(dd.invoice.id, 10)).id;
  await dispute(dd.order.id, { reason: 'Never delivered' });
  r = await resolve(dd.order.id, { action: 'CANCEL', comment: 'Supplier did not deliver' });
  check('CANCEL -> 200, order CANCELLED', r.status === 200 && (await ordOf(dd.order.id)).status === 'CANCELLED');
  check('...pending payment FAILED, invoice CANCELLED', (await db.payment.findUnique({ where: { id: pendingId } })).status === 'FAILED' &&
    (await db.invoice.findUnique({ where: { id: dd.invoice.id } })).status === 'CANCELLED');
  check('...admin comment says cancelled', (await db.message.findFirst({ where: { orderId: dd.order.id, senderCompanyId: null } })).body === 'Dispute resolved — order cancelled: Supplier did not deliver');
  await settle();
  check('...both parties notified', (await notesOf('buyer1', 'DISPUTE_RESOLVED', dd.order.id))[0]?.title === 'Dispute resolved: order cancelled' && (await notesOf('sup2', 'DISPUTE_RESOLVED', dd.order.id)).length === 1);

  // CANCEL keeps an invoice that has confirmed money on it
  dd = await makeOrder(60, S2, 'sup2');
  await call('PATCH', `/payments/${(await legacyPayment(dd.invoice.id, 20)).id}/confirm`, S2, {});
  await dispute(dd.order.id, {});
  check('CANCEL with confirmed money -> invoice kept PARTIALLY_PAID', (await resolve(dd.order.id, { action: 'CANCEL', comment: 'Refund off-platform' })).status === 200 &&
    (await db.invoice.findUnique({ where: { id: dd.invoice.id } })).status === 'PARTIALLY_PAID');

  // disputes opened before statusBeforeDispute existed: RESUME falls back to what the delivery proves
  dd = await makeOrder(30, S2, 'sup2');
  await call('PATCH', `/orders/${dd.order.id}/status`, S2, { status: 'IN_PROGRESS' });
  await dispute(dd.order.id, {});
  await db.order.update({ where: { id: dd.order.id }, data: { statusBeforeDispute: null } });
  check('RESUME without remembered status, delivery PENDING -> CONFIRMED', (await resolve(dd.order.id, { action: 'RESUME', comment: 'x' })).status === 200 && (await ordOf(dd.order.id)).status === 'CONFIRMED');

  // RESUME and CANCEL at the same time: exactly one wins
  for (let round = 1; round <= 4; round++) {
    dd = await makeOrder(20, S2, 'sup2');
    await dispute(dd.order.id, {});
    const [a1, a2] = await Promise.all([resolve(dd.order.id, { action: 'RESUME', comment: 'r' }), resolve(dd.order.id, { action: 'CANCEL', comment: 'c' })]);
    o = await ordOf(dd.order.id);
    const adminMsgs = await db.message.count({ where: { orderId: dd.order.id, senderCompanyId: null } });
    check(`resume vs cancel race (round ${round}): one 200 + one 400, one admin comment`,
      [a1.status, a2.status].sort().join() === '200,400' && adminMsgs === 1 && (a1.status === 200 ? o.status === 'CONFIRMED' : o.status === 'CANCELLED'),
      { resume: a1.status, cancel: a2.status, order: o.status, adminMsgs });
  }

  console.log('\n== 18c4. receipt confirmation: acceptance before invoice and payment ==');
  const receipt = (id, body = {}, tokn = B1) => call('POST', `/orders/${id}/receipt`, tokn, body);
  const RECEIPT_MSG = 'Receipt confirmed: all goods received in the agreed quantity and quality.';
  let ro = await makeOrder(70, S2, 'sup2');
  const rinv = await db.invoice.findUnique({ where: { orderId: ro.order.id } });
  r = await receipt(ro.order.id);
  check('receipt before shipment -> 400, nothing recorded', r.status === 400 && /once the order is shipped/.test(r.data.error) && (await ordOf(ro.order.id)).receivedAt === null, r.data);
  check('payment before receipt -> 400', (await call('POST', `/invoices/${rinv.id}/payments`, B1, { amount: 10, method: 'cash' })).status === 400);
  await call('PATCH', `/orders/${ro.order.id}/delivery`, S2, { status: 'DISPATCHED', trackingInfo: 'TRK-R1' });
  check('supplier cannot confirm receipt -> 403', (await receipt(ro.order.id, {}, S2)).status === 403);
  check('other buyer -> 403', (await receipt(ro.order.id, {}, B2)).status === 403);
  check('unknown order -> 404', (await receipt('00000000-0000-0000-0000-000000000000')).status === 404);
  check('comment over 1000 chars -> 400', (await receipt(ro.order.id, { comment: 'x'.repeat(1001) })).status === 400 && (await ordOf(ro.order.id)).receivedAt === null);
  const before = Date.now();
  r = await receipt(ro.order.id, { comment: '  Counted and checked  ' });
  o = await ordOf(ro.order.id);
  const rdel = await db.delivery.findUnique({ where: { orderId: ro.order.id } });
  const rinvAfter = await db.invoice.findUnique({ where: { id: rinv.id } });
  check('receipt on SHIPPED -> 200, receivedAt set, order DELIVERED', r.status === 200 && o.status === 'DELIVERED' && o.receivedAt && o.receivedAt.getTime() >= before - 1000, o);
  check('...delivery marked DELIVERED with deliveredAt', rdel.status === 'DELIVERED' && !!rdel.deliveredAt);
  check('...invoice issuedAt = receipt time', rinvAfter.issuedAt.getTime() === o.receivedAt.getTime() && rinvAfter.status === 'ISSUED');
  msgs = await db.message.findMany({ where: { orderId: ro.order.id } });
  check('...chat message by the buyer with the note', msgs.length === 1 && msgs[0].senderCompanyId === 'buyer1' && msgs[0].body === RECEIPT_MSG + ' Note: Counted and checked', msgs);
  await settle();
  const rnote = (await notesOf('sup2', 'RECEIPT_CONFIRMED', ro.order.id))[0];
  check('...supplier notified', !!rnote && /confirmed receipt of "Pay 70"/.test(rnote.body) && /Counted and checked/.test(rnote.body), rnote);
  check('receipt again -> 400', (await receipt(ro.order.id)).status === 400 && (await db.message.count({ where: { orderId: ro.order.id } })) === 1);
  r = await dispute(ro.order.id, { reason: 'too late' });
  check('dispute after receipt -> 400, order stays DELIVERED', r.status === 400 && /no longer be disputed/.test(r.data.error) && (await ordOf(ro.order.id)).status === 'DELIVERED', r.data);
  r = await call('POST', `/invoices/${rinv.id}/payments`, B1, { amount: 70, method: 'bank_transfer' });
  check('payment after receipt -> 201', r.status === 201, r.data);
  check('...confirmed -> order COMPLETED', (await call('PATCH', `/payments/${r.data.payment.id}/confirm`, S2, {})).status === 200 && (await ordOf(ro.order.id)).status === 'COMPLETED');

  // supplier already marked delivered: receipt keeps the delivery time; no comment -> plain message
  ro = await makeOrder(30, S2, 'sup2');
  await call('PATCH', `/orders/${ro.order.id}/delivery`, S2, { status: 'DISPATCHED' });
  await call('PATCH', `/orders/${ro.order.id}/delivery`, S2, { status: 'DELIVERED' });
  const deliveredAt = (await db.delivery.findUnique({ where: { orderId: ro.order.id } })).deliveredAt;
  check('receipt on DELIVERED -> 200', (await receipt(ro.order.id)).status === 200 && (await ordOf(ro.order.id)).status === 'DELIVERED');
  check('...supplier delivery time kept', (await db.delivery.findUnique({ where: { orderId: ro.order.id } })).deliveredAt.getTime() === deliveredAt.getTime());
  check('...message without note', (await db.message.findFirst({ where: { orderId: ro.order.id } })).body === RECEIPT_MSG);

  // disputed order: no receipt until the admin resumes it
  ro = await makeOrder(30, S2, 'sup2');
  await call('PATCH', `/orders/${ro.order.id}/delivery`, S2, { status: 'DISPATCHED' });
  await dispute(ro.order.id, { reason: 'Wrong items' });
  check('receipt on DISPUTED -> 400', (await receipt(ro.order.id)).status === 400 && (await ordOf(ro.order.id)).receivedAt === null);
  await resolve(ro.order.id, { action: 'RESUME', comment: 'Correct items sent' });
  check('...after RESUME (SHIPPED) receipt -> 200', (await receipt(ro.order.id)).status === 200);

  // pre-rule payment fully paid before receipt: order not completed until receipt
  ro = await makeOrder(25, S2, 'sup2');
  const lp2 = await legacyPayment(ro.invoice.id, 25);
  await call('PATCH', `/payments/${lp2.id}/confirm`, S2, {});
  check('full payment before receipt -> invoice PAID, order NOT completed', (await db.invoice.findUnique({ where: { id: ro.invoice.id } })).status === 'PAID' && (await ordOf(ro.order.id)).status === 'CONFIRMED');
  await call('PATCH', `/orders/${ro.order.id}/delivery`, S2, { status: 'DISPATCHED' });
  check('...buyer can still dispute it before receipt', (await dispute(ro.order.id, {})).status === 200);
  await resolve(ro.order.id, { action: 'RESUME', comment: 'ok' });
  check('...receipt of the paid order -> COMPLETED', (await receipt(ro.order.id)).status === 200 && (await ordOf(ro.order.id)).status === 'COMPLETED');

  // receipt and dispute at the same time: exactly one wins
  for (let round = 1; round <= 4; round++) {
    ro = await makeOrder(15, S2, 'sup2');
    await call('PATCH', `/orders/${ro.order.id}/delivery`, S2, { status: 'DISPATCHED' });
    const [rc, dp] = round % 2 ? await Promise.all([receipt(ro.order.id), dispute(ro.order.id, { reason: 'r' })]) : (await Promise.all([dispute(ro.order.id, { reason: 'r' }), receipt(ro.order.id)])).reverse();
    o = await ordOf(ro.order.id);
    const ok = (rc.status === 200 && dp.status >= 400 && o.status === 'DELIVERED' && !!o.receivedAt) || (rc.status === 400 && dp.status === 200 && o.status === 'DISPUTED' && !o.receivedAt);
    check(`receipt vs dispute race (round ${round}): exactly one wins, consistent`, ok, { receipt: rc.status, dispute: dp.status, order: o.status, receivedAt: !!o.receivedAt });
  }

  console.log('\n== 18c5. L4 order documents in private storage ==');
  // A minimal local S3 stand-in: stores PUT objects in memory, serves them to presigned GETs (the signature
  // itself isn't verified; what the SDK sends and what the presigned URL asks for is checked below).
  const http = require('http');
  const s3Store = new Map();
  let s3Fail = false;
  const lastGets = [];
  const s3Server = http.createServer((q, res) => {
    const u = new URL(q.url, 'http://x');
    if (q.method === 'PUT') {
      const chunks = [];
      q.on('data', (c) => chunks.push(c));
      q.on('end', () => {
        if (s3Fail) { res.writeHead(500); return res.end('<Error><Code>InternalError</Code></Error>'); }
        s3Store.set(decodeURIComponent(u.pathname), { body: Buffer.concat(chunks), contentType: q.headers['content-type'], headers: q.headers });
        res.writeHead(200, { ETag: '"etag"' }); res.end();
      });
      return;
    }
    const obj = s3Store.get(decodeURIComponent(u.pathname));
    lastGets.push(u);
    if (q.method !== 'GET' || !obj) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': u.searchParams.get('response-content-type') || obj.contentType, 'Content-Disposition': u.searchParams.get('response-content-disposition') || '' });
    res.end(obj.body);
  });
  await new Promise((resolve) => s3Server.listen(0, '127.0.0.1', resolve));

  const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 0x20), Buffer.from('\n%%EOF')]);
  const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  const JPG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 2)]);
  const upload = async (orderId, tokn, { kind, file, name = 'file.pdf', extra } = {}) => {
    const form = new FormData();
    if (kind !== undefined) form.append('kind', kind);
    if (file) form.append('file', new Blob([file]), name);
    if (extra) extra(form);
    const r = await fetch(`${BASE}/orders/${orderId}/documents`, { method: 'POST', headers: tokn ? { Authorization: 'Bearer ' + tokn } : {}, body: form });
    let data = null; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
  };
  const docRows = (orderId) => db.orderDocument.count({ where: { orderId } });

  let dso = await makeOrder(90, S2, 'sup2');
  r = await upload(dso.order.id, S2, { kind: 'DELIVERY_NOTE', file: PDF_BYTES });
  check('storage not configured -> 503, nothing stored', r.status === 503 && (await docRows(dso.order.id)) === 0, r.data);
  Object.assign(process.env, { S3_ENDPOINT: `http://127.0.0.1:${s3Server.address().port}`, S3_REGION: 'auto', S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY_ID: 'test-key', S3_SECRET_ACCESS_KEY: 'test-secret', S3_FORCE_PATH_STYLE: 'true' });

  r = await upload(dso.order.id, S2, { kind: 'DELIVERY_NOTE', file: PDF_BYTES, name: 'Delivery note 0042.pdf' });
  const dn = r.data;
  const dnRow = dn && await db.orderDocument.findUnique({ where: { id: dn.id } });
  const dnObj = dnRow && s3Store.get('/test-bucket/' + dnRow.storageKey);
  check('supplier uploads delivery note PDF_BYTES -> 201', r.status === 201 && dn.kind === 'DELIVERY_NOTE' && dn.fileName === 'Delivery note 0042.pdf' && dn.contentType === 'application/pdf' && dn.sizeBytes === PDF_BYTES.length, r.data);
  check('...response has no storage key', dn && !('storageKey' in dn));
  check('...PUT without optional checksum headers', !!dnObj && !Object.keys(dnObj.headers).some((h) => /^x-amz-(checksum-|sdk-checksum)/.test(h)), dnObj && Object.keys(dnObj.headers));
  check('...object stored under orders/<orderId>/<uuid> with exact bytes and type', !!dnObj && /^orders\/[0-9a-f-]+\/[0-9a-f-]{36}$/.test(dnRow.storageKey) && dnRow.storageKey.startsWith('orders/' + dso.order.id + '/') &&
    dnObj.body.equals(PDF_BYTES) && dnObj.contentType === 'application/pdf', dnRow && dnRow.storageKey);
  await settle();
  check('...buyer notified', (await notesOf('buyer1', 'DOCUMENT_ADDED', dso.order.id)).some((n) => n.title === 'New delivery note on your order' && n.body === 'Co sup2 added "Delivery note 0042.pdf".'));

  check('buyer cannot add a delivery note -> 403', (await upload(dso.order.id, B1, { kind: 'DELIVERY_NOTE', file: PDF_BYTES })).status === 403);
  check('buyer cannot add an invoice -> 403', (await upload(dso.order.id, B1, { kind: 'INVOICE', file: PDF_BYTES })).status === 403);
  r = await upload(dso.order.id, B1, { kind: 'OTHER', file: PNG_BYTES, name: 'damage photo.png' });
  check('buyer adds another document (PNG_BYTES) -> 201', r.status === 201 && r.data.contentType === 'image/png' && r.data.uploadedByCompany.name === 'Co buyer1', r.data);
  const buyerDocId = r.data.id;
  check('supplier adds an invoice -> 201', (await upload(dso.order.id, S2, { kind: 'INVOICE', file: PDF_BYTES, name: 'INV-7.pdf' })).status === 201);
  const rowsNow = await docRows(dso.order.id);
  check('bad kind -> 400', (await upload(dso.order.id, S2, { kind: 'RECEIPT', file: PDF_BYTES })).status === 400);
  check('missing kind -> 400', (await upload(dso.order.id, S2, { file: PDF_BYTES })).status === 400);
  check('no file -> 400', (await upload(dso.order.id, S2, { kind: 'OTHER' })).status === 400);
  check('empty file -> 400', (await upload(dso.order.id, S2, { kind: 'OTHER', file: Buffer.alloc(0) })).status === 400);
  r = await upload(dso.order.id, S2, { kind: 'OTHER', file: Buffer.from('hello, not a pdf'), name: 'fake.pdf' });
  check('text renamed .pdf -> 415', r.status === 415 && /PDF, JPEG, PNG or WebP/.test(r.data.error), r.data);
  check('SVG -> 415', (await upload(dso.order.id, S2, { kind: 'OTHER', file: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), name: 'x.svg' })).status === 415);
  check('HTML renamed .png -> 415', (await upload(dso.order.id, S2, { kind: 'OTHER', file: Buffer.from('<html><script>alert(1)</script></html>'), name: 'x.png' })).status === 415);
  r = await upload(dso.order.id, S2, { kind: 'OTHER', file: Buffer.alloc(10 * 1024 * 1024 + 1, 0x25), name: 'big.pdf' });
  check('file over 10 MB -> 413', r.status === 413 && /at most 10 MB/.test(r.data.error), r.data);
  check('two files in one request -> 400', (await upload(dso.order.id, S2, { kind: 'OTHER', file: PDF_BYTES, extra: (f) => f.append('file', new Blob([PDF_BYTES]), 'b.pdf') })).status === 400);
  check('JSON instead of multipart -> 400', (await call('POST', `/orders/${dso.order.id}/documents`, S2, { kind: 'OTHER' })).status === 400);
  check('...rejected uploads stored nothing', (await docRows(dso.order.id)) === rowsNow && s3Store.size === rowsNow);
  r = await upload(dso.order.id, S2, { kind: 'OTHER', file: JPG_BYTES, name: 'photo' });
  check('JPEG without extension -> name gets .jpg', r.status === 201 && r.data.fileName === 'photo.jpg', r.data);
  r = await upload(dso.order.id, S2, { kind: 'OTHER', file: PDF_BYTES, name: '..\\..\\etc/passwd.pdf' });
  check('path in file name is dropped', r.status === 201 && r.data.fileName === 'passwd.pdf', r.data);
  check('outsider supplier / other buyer -> 403', (await upload(dso.order.id, S1, { kind: 'OTHER', file: PDF_BYTES })).status === 403 && (await upload(dso.order.id, B2, { kind: 'OTHER', file: PDF_BYTES })).status === 403);
  check('admin cannot upload -> 403', (await upload(dso.order.id, ADM, { kind: 'OTHER', file: PDF_BYTES })).status === 403);
  check('unknown order -> 404', (await upload('00000000-0000-0000-0000-000000000000', S2, { kind: 'OTHER', file: PDF_BYTES })).status === 404);
  s3Fail = true;
  const before502 = await docRows(dso.order.id);
  r = await upload(dso.order.id, S2, { kind: 'OTHER', file: PDF_BYTES });
  s3Fail = false;
  check('storage failure -> 502, no row', r.status === 502 && /try again/.test(r.data.error) && (await docRows(dso.order.id)) === before502, r.data);

  // list
  r = await call('GET', `/orders/${dso.order.id}/documents`, B1);
  check('buyer lists documents (oldest first, no storage keys)', r.status === 200 && r.data.length === 5 && r.data[0].id === dn.id && r.data.every((x) => !('storageKey' in x)), r.data && r.data.map((x) => x.fileName));
  check('supplier and admin can list', (await call('GET', `/orders/${dso.order.id}/documents`, S2)).data.length === 5 && (await call('GET', `/orders/${dso.order.id}/documents`, ADM)).data.length === 5);
  check('outsider cannot list -> 403', (await call('GET', `/orders/${dso.order.id}/documents`, S1)).status === 403 && (await call('GET', `/orders/${dso.order.id}/documents`, B2)).status === 403);

  // download: presigned for 120 s, as an attachment under the original name
  r = await call('GET', `/documents/${dn.id}/download`, B1);
  const dl = r.status === 200 && new URL(r.data.url);
  check('buyer gets a presigned URL for 120 s', r.status === 200 && r.data.expiresIn === 120 && dl.searchParams.get('X-Amz-Expires') === '120' && !!dl.searchParams.get('X-Amz-Signature') &&
    dl.pathname === '/test-bucket/' + dnRow.storageKey && !dl.searchParams.has('x-amz-checksum-mode'), r.data);
  check('...downloads as an attachment with the original name', /^attachment; filename="Delivery note 0042\.pdf"; filename\*=UTF-8''Delivery%20note%200042\.pdf$/.test(dl.searchParams.get('response-content-disposition') || ''), dl && dl.searchParams.get('response-content-disposition'));
  const got = await fetch(r.data.url);
  check('...URL serves the file', got.status === 200 && Buffer.from(await got.arrayBuffer()).equals(PDF_BYTES) && got.headers.get('content-type') === 'application/pdf');
  check('supplier and admin can download', (await call('GET', `/documents/${dn.id}/download`, S2)).status === 200 && (await call('GET', `/documents/${dn.id}/download`, ADM)).status === 200);
  check('outsider cannot download -> 403', (await call('GET', `/documents/${dn.id}/download`, S1)).status === 403 && (await call('GET', `/documents/${dn.id}/download`, B2)).status === 403);
  check('unknown document -> 404', (await call('GET', '/documents/00000000-0000-0000-0000-000000000000/download', B1)).status === 404);
  r = await upload(dso.order.id, B1, { kind: 'OTHER', file: PDF_BYTES, name: 'Счёт №5.pdf' });
  const uni = new URL((await call('GET', `/documents/${r.data.id}/download`, B1)).data.url).searchParams.get('response-content-disposition');
  check('non-ASCII name: ASCII fallback + UTF-8 name', uni === `attachment; filename="____ _5.pdf"; filename*=UTF-8''${encodeURIComponent('Счёт №5.pdf')}`, uni);

  // delete: only the uploader, while the order is open; the stored file is kept
  check('buyer cannot delete the supplier\'s document -> 403', (await call('DELETE', `/documents/${dn.id}`, B1)).status === 403);
  check('admin cannot delete -> 403', (await call('DELETE', `/documents/${dn.id}`, ADM)).status === 403);
  check('supplier deletes own document -> 200', (await call('DELETE', `/documents/${dn.id}`, S2)).status === 200);
  check('...hidden from the list, download 404', !(await call('GET', `/orders/${dso.order.id}/documents`, B1)).data.some((x) => x.id === dn.id) && (await call('GET', `/documents/${dn.id}/download`, B1)).status === 404);
  check('...row soft-deleted, stored file kept', !!(await db.orderDocument.findUnique({ where: { id: dn.id } })).deletedAt && s3Store.has('/test-bucket/' + dnRow.storageKey));
  check('delete again -> 404', (await call('DELETE', `/documents/${dn.id}`, S2)).status === 404);
  await db.order.update({ where: { id: dso.order.id }, data: { status: 'COMPLETED' } });
  check('delete on a COMPLETED order -> 400', (await call('DELETE', `/documents/${buyerDocId}`, B1)).status === 400);
  check('upload to a COMPLETED order still allowed -> 201', (await upload(dso.order.id, S2, { kind: 'INVOICE', file: PDF_BYTES })).status === 201);
  await db.order.update({ where: { id: dso.order.id }, data: { status: 'CANCELLED' } });
  check('upload to a CANCELLED order -> 400', (await upload(dso.order.id, S2, { kind: 'OTHER', file: PDF_BYTES })).status === 400);
  check('...its documents stay readable', (await call('GET', `/documents/${buyerDocId}/download`, S2)).status === 200);

  // at most 50 live documents per order
  dso = await makeOrder(10, S2, 'sup2');
  await db.orderDocument.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ orderId: dso.order.id, kind: 'OTHER', fileName: `f${i}.pdf`, contentType: 'application/pdf', sizeBytes: 1, storageKey: `seed/${dso.order.id}/${i}`, uploadedByCompanyId: 'sup2' })) });
  r = await upload(dso.order.id, B1, { kind: 'OTHER', file: PDF_BYTES });
  check('51st document -> 400', r.status === 400 && /at most 50/.test(r.data.error), r.data);
  check('DB rejects kind outside the list (CHECK)', await db.orderDocument.create({ data: { orderId: dso.order.id, kind: 'CONTRACT', fileName: 'x', contentType: 'application/pdf', sizeBytes: 1, storageKey: 'seed/x', uploadedByCompanyId: 'sup2' } }).then(() => false, () => true));

  console.log('\n== 18c6. L4 bid attachments: private to supplier, buyer, admin ==');
  const uploadAtt = async (quoteId, tokn, file = PDF_BYTES, name = 'spec.pdf') => {
    const form = new FormData();
    if (file) form.append('file', new Blob([file]), name);
    const res = await fetch(`${BASE}/quotes/${quoteId}/attachments`, { method: 'POST', headers: { Authorization: 'Bearer ' + tokn }, body: form });
    let data = null; try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };
  const attRows = (quoteId) => db.quoteAttachment.count({ where: { quoteId, deletedAt: null } });
  const quoteOf = async (rfqId, supId) => db.quote.findFirst({ where: { rfqId, supplierCompanyId: supId } });
  await db.wallet.updateMany({ where: { companyId: { in: ['sup1', 'sup2', 'sup3'] } }, data: { balance: 100 } });
  const arfq = await newRfq(100, { title: 'L9 attachments RFQ' });
  for (const [s, price] of [[S1, 50], [S2, 60], [S3, 70]]) await call('POST', `/rfqs/${arfq.id}/quotes`, s, { price });
  const aq1 = await quoteOf(arfq.id, 'sup1'), aq2 = await quoteOf(arfq.id, 'sup2'), aq3 = await quoteOf(arfq.id, 'sup3');

  r = await uploadAtt(aq1.id, S1, PDF_BYTES, 'ISO 9001 certificate.pdf');
  const att1 = r.data;
  const att1Row = att1 && await db.quoteAttachment.findUnique({ where: { id: att1.id } });
  check('supplier attaches a PDF to its quote -> 201', r.status === 201 && att1.fileName === 'ISO 9001 certificate.pdf' && att1.sizeBytes === PDF_BYTES.length && !('storageKey' in att1), r.data);
  check('...stored under quotes/<quoteId>/<uuid>', !!att1Row && att1Row.storageKey.startsWith('quotes/' + aq1.id + '/') && s3Store.get('/test-bucket/' + att1Row.storageKey).body.equals(PDF_BYTES));
  check('buyer cannot attach -> 403', (await uploadAtt(aq1.id, B1)).status === 403);
  check('another supplier: quote "not found" -> 404', (await uploadAtt(aq1.id, S2)).status === 404);
  check('fake PDF -> 415', (await uploadAtt(aq1.id, S1, Buffer.from('not a pdf'), 'x.pdf')).status === 415);
  check('no file -> 400', (await uploadAtt(aq1.id, S1, null)).status === 400);
  for (const [f, n] of [[PNG_BYTES, 'photo 1.png'], [JPG_BYTES, 'photo 2'], [PDF_BYTES, 'datasheet.pdf'], [PDF_BYTES, 'price list.pdf']]) await uploadAtt(aq1.id, S1, f, n);
  r = await uploadAtt(aq1.id, S1);
  check('6th attachment -> 400, 5 kept', r.status === 400 && /at most 5/.test(r.data.error) && (await attRows(aq1.id)) === 5, r.data);
  // parallel uploads can't exceed 5 (checked again under the RFQ lock)
  const parUp = await Promise.all(Array.from({ length: 7 }, (_, i) => uploadAtt(aq2.id, S2, PDF_BYTES, `p${i}.pdf`)));
  check('7 parallel uploads -> exactly 5 stored', parUp.filter((x) => x.status === 201).length === 5 && parUp.filter((x) => x.status === 400).length === 2 && (await attRows(aq2.id)) === 5, parUp.map((x) => x.status));

  // who sees what
  r = await call('GET', `/quotes/${aq1.id}/attachments`, S1);
  check('supplier lists own attachments (oldest first, no keys)', r.status === 200 && r.data.length === 5 && r.data[0].id === att1.id && r.data.every((x) => !('storageKey' in x)));
  check('buyer and admin list them', (await call('GET', `/quotes/${aq1.id}/attachments`, B1)).data.length === 5 && (await call('GET', `/quotes/${aq1.id}/attachments`, ADM)).data.length === 5);
  check('other supplier / other buyer -> 404', (await call('GET', `/quotes/${aq1.id}/attachments`, S2)).status === 404 && (await call('GET', `/quotes/${aq1.id}/attachments`, B2)).status === 404);
  r = await call('GET', `/rfqs/${arfq.id}/quotes`, B1);
  check('Compare bids: buyer sees each quote\'s attachments', r.status === 200 && r.data.find((q) => q.id === aq1.id).attachments.length === 5 && r.data.find((q) => q.id === aq2.id).attachments.length === 5 &&
    r.data.find((q) => q.id === aq3.id).attachments.length === 0);
  const s1AttIds = (await db.quoteAttachment.findMany({ where: { quoteId: aq1.id } })).map((a) => a.id);
  const leaks = (json) => [aq1.id, ...s1AttIds].some((id) => JSON.stringify(json).includes(id));
  r = await call('GET', `/rfqs/${arfq.id}/quotes`, S3);
  check('another supplier gets only its own quote (0 attachments), nothing of sup1', r.data.length === 1 && r.data[0].id === aq3.id && r.data[0].attachments.length === 0 && !leaks(r.data), r.data);
  const listS3 = (await call('GET', '/rfqs', S3)).data.find((x) => x.id === arfq.id);
  check('RFQ list for another supplier: own quote count only, nothing of sup1', listS3.quotes.length === 1 && listS3.quotes[0]._count.attachments === 0 && !leaks(listS3), listS3.quotes);
  const listS1 = (await call('GET', '/rfqs', S1)).data.find((x) => x.id === arfq.id);
  check('RFQ list for the supplier: its own attachment count', listS1.quotes[0]._count.attachments === 5);
  check('RFQ detail for another supplier leaks nothing of sup1', !leaks((await call('GET', `/rfqs/${arfq.id}`, S3)).data));

  // download
  r = await call('GET', `/quote-attachments/${att1.id}/download`, B1);
  const au = r.status === 200 && new URL(r.data.url);
  check('buyer downloads: presigned 120 s, attachment disposition', r.status === 200 && au.searchParams.get('X-Amz-Expires') === '120' && au.pathname === '/test-bucket/' + att1Row.storageKey &&
    /^attachment; filename="ISO 9001 certificate\.pdf"/.test(au.searchParams.get('response-content-disposition')), r.data);
  check('supplier and admin download', (await call('GET', `/quote-attachments/${att1.id}/download`, S1)).status === 200 && (await call('GET', `/quote-attachments/${att1.id}/download`, ADM)).status === 200);
  check('other supplier / other buyer -> 404', (await call('GET', `/quote-attachments/${att1.id}/download`, S2)).status === 404 && (await call('GET', `/quote-attachments/${att1.id}/download`, B2)).status === 404);

  // delete while SUBMITTED
  check('buyer cannot delete -> 403', (await call('DELETE', `/quote-attachments/${att1.id}`, B1)).status === 403);
  check('other supplier -> 404', (await call('DELETE', `/quote-attachments/${att1.id}`, S2)).status === 404);
  const lastId = (await call('GET', `/quotes/${aq1.id}/attachments`, S1)).data[4].id;
  check('supplier removes one -> 200, 4 left, file kept', (await call('DELETE', `/quote-attachments/${lastId}`, S1)).status === 200 && (await attRows(aq1.id)) === 4 &&
    s3Store.has('/test-bucket/' + (await db.quoteAttachment.findUnique({ where: { id: lastId } })).storageKey));
  check('...removed one: download 404, delete again 404', (await call('GET', `/quote-attachments/${lastId}/download`, B1)).status === 404 && (await call('DELETE', `/quote-attachments/${lastId}`, S1)).status === 404);

  // frozen after shortlist / rejection, and when the RFQ stops taking quotes
  await call('PATCH', `/quotes/${aq1.id}/shortlist`, B1);
  r = await uploadAtt(aq1.id, S1);
  check('after shortlist: upload -> 400 (frozen)', r.status === 400 && /frozen once the quote is shortlisted/.test(r.data.error), r.data);
  check('after shortlist: delete -> 400', (await call('DELETE', `/quote-attachments/${att1.id}`, S1)).status === 400 && (await attRows(aq1.id)) === 4);
  check('...buyer still sees the 4 files it evaluates', (await call('GET', `/quotes/${aq1.id}/attachments`, B1)).data.length === 4);
  await call('PATCH', `/quotes/${aq3.id}/reject`, B1);
  check('after rejection: upload -> 400', (await uploadAtt(aq3.id, S3)).status === 400);
  const rq2 = await newRfq(100, { title: 'L9 attachments deadline' });
  await call('POST', `/rfqs/${rq2.id}/quotes`, S3, { price: 40 });
  const dq = await quoteOf(rq2.id, 'sup3');
  check('before the deadline: upload -> 201', (await uploadAtt(dq.id, S3)).status === 201);
  await db.rFQ.update({ where: { id: rq2.id }, data: { deadline: new Date(Date.now() - 1000) } });
  r = await uploadAtt(dq.id, S3);
  check('after the deadline: upload -> 400', r.status === 400 && /deadline/.test(r.data.error), r.data);
  await db.rFQ.update({ where: { id: rq2.id }, data: { deadline: new Date(Date.now() + 86400e3), status: 'QUOTING_CLOSED' } });
  check('RFQ QUOTING_CLOSED: upload / delete -> 400', (await uploadAtt(dq.id, S3)).status === 400 &&
    (await call('DELETE', `/quote-attachments/${(await call('GET', `/quotes/${dq.id}/attachments`, S3)).data[0].id}`, S3)).status === 400);

  // upload racing a shortlist: an attachment never lands after the shortlist
  for (let round = 1; round <= 4; round++) {
    const rr = await newRfq(100, { title: 'L9 race ' + round });
    await call('POST', `/rfqs/${rr.id}/quotes`, S3, { price: 30 });
    const rq = await quoteOf(rr.id, 'sup3');
    const [up, sl] = await Promise.all([uploadAtt(rq.id, S3), call('PATCH', `/quotes/${rq.id}/shortlist`, B1)]);
    const after = await db.quote.findUnique({ where: { id: rq.id } });
    const rows = await db.quoteAttachment.findMany({ where: { quoteId: rq.id } });
    const ok = sl.status === 200 && after.status === 'SHORTLISTED' && ((up.status === 201 && rows.length === 1 && rows[0].createdAt <= after.updatedAt) || (up.status === 400 && rows.length === 0));
    check(`upload vs shortlist race (round ${round}): no attachment after the shortlist`, ok, { upload: up.status, shortlist: sl.status, rows: rows.length });
  }

  // award + LPO acceptance: the winning bid's attachments become order documents
  check('award sup1 -> 201', (await call('POST', `/quotes/${aq1.id}/award`, B1, {})).status === 201);
  const alpo = await db.lPO.findFirst({ where: { quoteId: aq1.id } });
  check('no order documents before acceptance', (await db.orderDocument.count({ where: { storageKey: att1Row.storageKey } })) === 0);
  r = await call('PATCH', `/lpos/${alpo.id}/accept`, S1);
  const aorder = r.data.order;
  const odocs = (await call('GET', `/orders/${aorder.id}/documents`, B1)).data;
  const liveKeys = (await db.quoteAttachment.findMany({ where: { quoteId: aq1.id, deletedAt: null }, orderBy: { createdAt: 'asc' } })).map((a) => a.storageKey);
  const odRows = await db.orderDocument.findMany({ where: { orderId: aorder.id }, orderBy: { createdAt: 'asc' } });
  check('LPO accepted -> 4 bid attachments in order documents (removed one excluded)', odocs.length === 4 && odocs.every((d) => d.kind === 'QUOTE_ATTACHMENT' && d.uploadedByCompanyId === 'sup1') &&
    JSON.stringify(odRows.map((d) => d.storageKey).sort()) === JSON.stringify([...liveKeys].sort()), odocs.map((d) => d.fileName));
  const odl = new URL((await call('GET', `/documents/${odocs[0].id}/download`, B1)).data.url);
  check('...downloadable from the order (same stored file)', odRows.map((d) => '/test-bucket/' + d.storageKey).includes(odl.pathname));
  r = await call('DELETE', `/documents/${odocs[0].id}`, S1);
  check('...supplier cannot remove a bid attachment from the order -> 400', r.status === 400 && /part of the accepted quote/.test(r.data.error), r.data);
  const qaForm = new FormData(); qaForm.append('kind', 'QUOTE_ATTACHMENT'); qaForm.append("file", new Blob([PDF_BYTES]), "x.pdf");
  check('...kind QUOTE_ATTACHMENT cannot be uploaded directly -> 400', (await fetch(`${BASE}/orders/${aorder.id}/documents`, { method: 'POST', headers: { Authorization: 'Bearer ' + S1 }, body: qaForm })).status === 400);
  check('losing bid\'s attachments stay visible to its supplier and the buyer', (await call('GET', `/quotes/${aq2.id}/attachments`, S2)).data.length === 5 && (await call('GET', `/quotes/${aq2.id}/attachments`, B1)).data.length === 5);

  // deleting a company without trading history removes its quotes' attachment rows too
  await mkCo('sup13', 'SUPPLIER', 100);
  const S13 = tok('SUPPLIER', 'sup13');
  const hrfq = await newRfq(100, { title: 'L9 hard delete' });
  await call('POST', `/rfqs/${hrfq.id}/quotes`, S13, { price: 20 });
  const hq = await quoteOf(hrfq.id, 'sup13');
  await uploadAtt(hq.id, S13);
  r = await call('DELETE', '/admin/companies/sup13', ADM);
  check('delete supplier with attachments, no trading history -> deleted, rows gone', r.status === 200 && r.data.mode === 'deleted' && (await db.quoteAttachment.count({ where: { quoteId: hq.id } })) === 0, r.data);
  s3Server.close();

  console.log('\n== 18d. L6 change-password attempts limited per user ==');
  await mkCo('sup11', 'SUPPLIER', 0); await mkCo('sup12', 'SUPPLIER', 0);
  const T11 = (await call('POST', '/auth/login', null, { email: 'sup11@t.test', password: 'pw123456' }, undefined, { 'X-Forwarded-For': '192.0.2.11, 10.0.0.1' })).data.token;
  const T12 = (await call('POST', '/auth/login', null, { email: 'sup12@t.test', password: 'pw123456' }, undefined, { 'X-Forwarded-For': '192.0.2.12, 10.0.0.1' })).data.token;
  const chpw = (tokn, currentPassword, newPassword = 'brandnew123') => call('PATCH', '/auth/password', tokn, { currentPassword, newPassword });
  const codes11 = [];
  for (let i = 0; i < 3; i++) codes11.push((await chpw(T11, 'pw123456', 'short')).status);   // validation errors
  check('validation errors (400) are not counted', codes11.every((c) => c === 400), codes11);
  const wrong = [];
  for (let i = 0; i < 5; i++) wrong.push((await chpw(T11, 'wrong-' + i)).status);
  check('5 wrong current passwords -> 401 each', wrong.every((c) => c === 401), wrong);
  r = await chpw(T11, 'wrong-6');
  check('6th wrong attempt -> 429', r.status === 429 && /Too many wrong password attempts/.test(r.data.error), r.data);
  r = await chpw(T11, 'pw123456');
  check('even the correct password is refused while blocked (no more guesses)', r.status === 429);
  check('password unchanged while blocked', (await call('POST', '/auth/login', null, { email: 'sup11@t.test', password: 'pw123456' }, undefined, { 'X-Forwarded-For': '192.0.2.11, 10.0.0.1' })).status === 200);
  r = await chpw(T12, 'wrong-a');
  check('another user is not affected by that limit', r.status === 401);
  r = await chpw(T12, 'pw123456');
  check('another user can still change the password', r.status === 200 && !!r.data.token);
  const T12b = r.data.token;
  const ok12 = [];
  for (let i = 0; i < 3; i++) ok12.push((await chpw(T12b, 'wrong-b' + i)).status);   // 1 + 3 = 4 failures
  r = await chpw(T12b, 'brandnew123', 'brandnew456');
  // if the successful change had counted, this would be the 5th strike and get 429
  check('successful change does not use the budget (1 wrong + success + 3 wrong, then success)', ok12.every((c) => c === 401) && r.status === 200, { ok12, last: r.status });

  console.log('\n== 19. L1 errors -> 4xx ==');
  r = await call('GET', '/rfqs?status=FOO', B1);
  check('invalid RFQ status filter -> 400', r.status === 400 && /status must be one of/.test(r.data.error), r.data);
  check('invalid admin status filter -> 400', (await call('GET', '/admin/companies?status=FOO', ADM)).status === 400);
  r = await call('PATCH', '/admin/companies/does-not-exist/verify', ADM, { status: 'VERIFIED' });
  check('verify unknown company -> 404 (P2025)', r.status === 404, r);
  r = await call('POST', '/catalog', S1, { name: 'x', price: 'abc' });
  check('catalog price "abc" -> 400 (validation)', r.status === 400, r);
  r = await call('POST', '/rfqs', B1, { title: 'x', description: 'y', quantity: 'abc', deadline: future() });
  check('RFQ quantity "abc" -> 400', r.status === 400, r);
  r = await call('PATCH', '/companies/me', ADM, { name: 'x' });
  check('admin without company PATCH /companies/me -> 4xx, not 500', r.status >= 400 && r.status < 500, r);

  console.log('\n== 20. transaction timeout defaults ==');
  const appPrisma = require(path.join(root, 'src/config/prisma'));
  const t0 = Date.now();
  try {
    await appPrisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_sleep(6)`; });
    check('interactive transaction may run > 5s (default would abort)', true, { ms: Date.now() - t0 });
  } catch (e) { check('interactive transaction may run > 5s (default would abort)', false, e.message); }
  try {
    await appPrisma.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_sleep(16)`; });
    check('transaction is still capped at 15s', false);
  } catch (e) { check('transaction is still capped at 15s', /timeout|expired|closed/i.test(e.message), e.message.split('\n').pop()); }

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
