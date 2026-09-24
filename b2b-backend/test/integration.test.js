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
process.env.JWT_SECRET = 'itest-secret';
process.env.PORT = process.env.TEST_APP_PORT;
process.env.RESEND_API_KEY = 're_test_dummy';
process.env.SENTRY_DSN = '';

// Stub Sentry so the hardcoded DSN never receives test events
const sentryPath = require.resolve('@sentry/node');
require.cache[sentryPath] = { id: sentryPath, filename: sentryPath, loaded: true,
  exports: { init() {}, setupExpressErrorHandler() {}, captureException() {} } };

// Stub Resend so registration tests never call the real email API
const resendPath = require.resolve('resend');
require.cache[resendPath] = { id: resendPath, filename: resendPath, loaded: true,
  exports: { Resend: class { constructor() { this.emails = { send: async () => ({ error: null }) }; } } } };

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
  check('admin resolves DISPUTED -> IN_PROGRESS -> 200', (await st(ADM, 'IN_PROGRESS')).status === 200);
  check('delivery invalid status -> 400', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'LOST' })).status === 400);
  check('delivery PENDING -> DELIVERED (skip) -> 400', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'DELIVERED' })).status === 400);
  check('delivery -> DISPATCHED -> 200, order SHIPPED', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'DISPATCHED', trackingInfo: 'TRK1' })).status === 200 && (await ordStatus()) === 'SHIPPED');
  check('tracking-only update -> 200', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { trackingInfo: 'TRK2' })).status === 200);
  check('delivery -> DELIVERED -> 200, order DELIVERED', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'DELIVERED' })).status === 200 && (await ordStatus()) === 'DELIVERED');
  check('delivery backwards DELIVERED -> DISPATCHED -> 400', (await call('PATCH', `/orders/${order1.id}/delivery`, S2, { status: 'DISPATCHED' })).status === 400);
  const inv1 = await db.invoice.findUnique({ where: { orderId: order1.id } });
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
  // helper: RFQ -> quote by sup -> award -> accept, returns { order, invoice }
  async function makeOrder(price, supTok, supId, buyerTok = B1) {
    await db.wallet.update({ where: { companyId: supId }, data: { balance: 1000 } });
    const rf = (await call('POST', '/rfqs', buyerTok, { title: 'Pay ' + price, description: 'x', budget: 100, deadline: future(), publish: true })).data;
    await call('POST', `/rfqs/${rf.id}/quotes`, supTok, { price });
    const q = await db.quote.findFirst({ where: { rfqId: rf.id } });
    await call('POST', `/quotes/${q.id}/award`, buyerTok, {});
    const l = await db.lPO.findFirst({ where: { rfqId: rf.id } });
    const acc = await call('PATCH', `/lpos/${l.id}/accept`, supTok);
    return { order: acc.data.order, invoice: await db.invoice.findUnique({ where: { orderId: acc.data.order.id } }), rfq: rf };
  }
  const { order: po, invoice: pinv } = await makeOrder(100, S2, 'sup2');
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
  check('confirm 40 -> invoice PARTIALLY_PAID, order not completed', r.status === 200 && r.data.invoice.status === 'PARTIALLY_PAID' && (await poStatus()) === 'CONFIRMED', r.data.invoice);

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

  // order cancelled with a pending payment -> payment FAILED, invoice CANCELLED, no more payments
  const { order: co, invoice: cinv } = await makeOrder(50, S2, 'sup2');
  const pp = (await call('POST', `/invoices/${cinv.id}/payments`, B1, { amount: 20, method: 'cash' })).data.payment;
  check('supplier cancels order with only a pending payment -> 200', (await call('PATCH', `/orders/${co.id}/status`, S2, { status: 'CANCELLED' })).status === 200);
  const ppAfter = await db.payment.findUnique({ where: { id: pp.id } });
  check('pending payment -> FAILED "Order cancelled", invoice CANCELLED', ppAfter.status === 'FAILED' && ppAfter.rejectReason === 'Order cancelled' && (await db.invoice.findUnique({ where: { id: cinv.id } })).status === 'CANCELLED');
  check('pay a CANCELLED invoice -> 400', (await call('POST', `/invoices/${cinv.id}/payments`, B1, { amount: 5, method: 'cash' })).status === 400);
  check('confirm payment of cancelled invoice -> 400', (await call('PATCH', `/payments/${pp.id}/confirm`, S2, {})).status === 400);
  const { order: ko, invoice: kinv } = await makeOrder(50, S2, 'sup2');
  const kp = (await call('POST', `/invoices/${kinv.id}/payments`, B1, { amount: 10, method: 'cash' })).data.payment;
  await call('PATCH', `/payments/${kp.id}/confirm`, S2, {});
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
  const { invoice: finv } = await makeOrder(12.345, S2, 'sup2');
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
  const { order: o5, invoice: i5 } = await makeOrder(80, S5, 'sup5', B5);
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
  const rt = (await db.user.findUnique({ where: { id: 'u-sup7' } })).resetToken;
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

  console.log('\n== 16. L1 errors -> 4xx ==');
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

  console.log('\n== 17. transaction timeout defaults ==');
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
