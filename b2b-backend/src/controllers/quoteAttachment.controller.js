// Bid attachments: up to 5 files a supplier adds to its quote. Only the supplier, the RFQ's buyer and admins
// can see them; to anyone else the quote and its files don't exist (404), so other suppliers can't even
// learn how many there are. Editable only while the quote is SUBMITTED and the RFQ open for quotes — once
// the buyer shortlists (or the RFQ closes), the buyer decides on exactly the files it has seen.
const Sentry = require('@sentry/node');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const storage = require('../utils/storage');
const { readSingleFile, sniffType, storedFileName } = require('../utils/upload');

const MAX_ATTACHMENTS_PER_QUOTE = 5;
const fail = (status, message) => Object.assign(new Error(message), { status });

// what the API shows about an attachment (never the storage key)
const ATTACHMENT_SELECT = { id: true, quoteId: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true };

// The caller's relation to a quote: 'supplier' (its author) | 'buyer' (of its RFQ) | 'admin', else 404
async function quoteAccess(quoteId, user) {
  const quote = await prisma.quote.findUnique({ where: { id: quoteId }, include: { rfq: { select: { buyerCompanyId: true } } } });
  if (quote && user.companyId && quote.supplierCompanyId === user.companyId) return { quote, role: 'supplier' };
  if (quote && user.companyId && quote.rfq.buyerCompanyId === user.companyId) return { quote, role: 'buyer' };
  if (quote && user.role === 'ADMIN') return { quote, role: 'admin' };
  return { error: [404, 'Quote not found'] };
}

// Throws unless the quote's attachments may change now. With `tx`, runs under the RFQ row lock — the same
// lock as shortlist, reject, award and cancel — so a change can't slip past a concurrent shortlist.
async function assertEditable(db, quoteId, lock) {
  const q = await db.quote.findUnique({ where: { id: quoteId }, select: { rfqId: true } });
  if (lock) await db.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${q.rfqId} FOR UPDATE`;
  const quote = await db.quote.findUnique({ where: { id: quoteId }, include: { rfq: { select: { status: true, deadline: true } } } });
  if (quote.status !== 'SUBMITTED') throw fail(400, `Attachments are frozen once the quote is ${quote.status.toLowerCase()}`);
  if (quote.rfq.status !== 'PUBLISHED') throw fail(400, 'Attachments can only be changed while the RFQ is open for quotes');
  if (quote.rfq.deadline && quote.rfq.deadline <= new Date()) throw fail(400, 'The deadline for this RFQ has passed');
  return quote;
}

const liveCount = (db, quoteId) => db.quoteAttachment.count({ where: { quoteId, deletedAt: null } });

// GET /api/quotes/:id/attachments  (the supplier, the RFQ's buyer, admin)
const listAttachments = asyncHandler(async (req, res) => {
  const { quote, error } = await quoteAccess(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const attachments = await prisma.quoteAttachment.findMany({
    where: { quoteId: quote.id, deletedAt: null }, select: ATTACHMENT_SELECT, orderBy: { createdAt: 'asc' },
  });
  res.json(attachments);
});

// POST /api/quotes/:id/attachments  (the supplier)  multipart/form-data: file
// One file per request, at most 10 MB, PDF / JPEG / PNG / WebP by content; at most 5 per quote.
const uploadAttachment = asyncHandler(async (req, res) => {
  if (!storage.isConfigured()) return res.status(503).json({ error: 'File storage is not configured' });
  const { quote, role, error } = await quoteAccess(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });
  if (role !== 'supplier') return res.status(403).json({ error: 'Only the supplier can add attachments to its quote' });
  // cheap checks before reading the body; repeated under the lock below
  await assertEditable(prisma, quote.id, false);
  if (await liveCount(prisma, quote.id) >= MAX_ATTACHMENTS_PER_QUOTE) {
    return res.status(400).json({ error: `A quote can have at most ${MAX_ATTACHMENTS_PER_QUOTE} attachments` });
  }

  const { file } = await readSingleFile(req);
  if (!file || file.buffer.length === 0) return res.status(400).json({ error: 'A file is required' });
  const contentType = sniffType(file.buffer);
  if (!contentType) return res.status(415).json({ error: 'Only PDF, JPEG, PNG or WebP files are accepted' });
  const fileName = storedFileName(file.fileName, contentType);

  const storageKey = storage.newKey(`quotes/${quote.id}`);
  try {
    await storage.putObject(storageKey, file.buffer, contentType);
  } catch (err) {
    Sentry.captureException(err, { tags: { area: 'storage' }, extra: { quoteId: quote.id, storageKey } });
    console.error('storage put failed:', err.message);
    return res.status(502).json({ error: 'Could not store the file, please try again' });
  }

  // the row is written after the object, under the RFQ lock: the quote may have been shortlisted, or
  // other uploads may have filled its 5 slots, while this file was uploading (then the object stays unused)
  const attachment = await prisma.$transaction(async (tx) => {
    await assertEditable(tx, quote.id, true);
    if (await liveCount(tx, quote.id) >= MAX_ATTACHMENTS_PER_QUOTE) throw fail(400, `A quote can have at most ${MAX_ATTACHMENTS_PER_QUOTE} attachments`);
    return tx.quoteAttachment.create({
      data: { quoteId: quote.id, fileName, contentType, sizeBytes: file.buffer.length, storageKey },
      select: ATTACHMENT_SELECT,
    });
  });
  res.status(201).json(attachment);
});

// Loads a live attachment and the caller's relation to its quote (404 for anyone without access)
async function attachmentAccess(id, user) {
  const attachment = await prisma.quoteAttachment.findFirst({ where: { id, deletedAt: null } });
  if (!attachment) return { error: [404, 'Attachment not found'] };
  const access = await quoteAccess(attachment.quoteId, user);
  if (access.error) return { error: [404, 'Attachment not found'] };
  return { attachment, ...access };
}

// GET /api/quote-attachments/:id/download  (the supplier, the RFQ's buyer, admin) -> { url, expiresIn, fileName }
const downloadAttachment = asyncHandler(async (req, res) => {
  if (!storage.isConfigured()) return res.status(503).json({ error: 'File storage is not configured' });
  const { attachment, error } = await attachmentAccess(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const url = await storage.presignDownload(attachment.storageKey, attachment.fileName, attachment.contentType);
  res.set('Cache-Control', 'no-store').json({ url, expiresIn: storage.DOWNLOAD_URL_TTL_SECONDS, fileName: attachment.fileName });
});

// DELETE /api/quote-attachments/:id  (the supplier, while the quote is editable) - hides it; the file is kept
const deleteAttachment = asyncHandler(async (req, res) => {
  const { attachment, role, error } = await attachmentAccess(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });
  if (role !== 'supplier') return res.status(403).json({ error: 'Only the supplier can remove attachments from its quote' });
  await prisma.$transaction(async (tx) => {
    await assertEditable(tx, attachment.quoteId, true);
    const { count } = await tx.quoteAttachment.updateMany({ where: { id: attachment.id, deletedAt: null }, data: { deletedAt: new Date() } });
    if (count === 0) throw fail(404, 'Attachment not found');
  });
  res.json({ ok: true });
});

module.exports = { listAttachments, uploadAttachment, downloadAttachment, deleteAttachment, ATTACHMENT_SELECT };
