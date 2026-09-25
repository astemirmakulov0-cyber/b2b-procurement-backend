const prisma = require('../config/prisma');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');
const { CANCELLABLE_STATUSES, cancelRfqInTx } = require('../utils/rfqCancel');
const Sentry = require('@sentry/node');
const { DOC_TYPES, checkDocument, DOC_META } = require('../utils/documents');
const storage = require('../utils/storage');

// GET /api/companies/me
const getMyCompany = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({
    where: { id: req.user.companyId },
    include: { documents: { select: DOC_META, orderBy: { uploadedAt: 'desc' } }, wallet: true },
  });
  res.json(company);
});

// PATCH /api/companies/me
// Name and CR number are what an admin verified: changing either on a VERIFIED company sends it back to
// IN_REVIEW, so it can't post RFQs or quote until an admin re-verifies it.
const updateMyCompany = asyncHandler(async (req, res) => {
  const { country, address, phone } = req.body;
  const trim = (v) => (typeof v === 'string' ? v.trim() : v);
  const name = trim(req.body.name);
  const registrationNumber = trim(req.body.registrationNumber);
  if (name !== undefined && !name) return res.status(400).json({ error: 'name cannot be empty' });
  const emailNewRfq = typeof req.body.emailNewRfq === 'boolean' ? req.body.emailNewRfq : undefined;
  const emailOtherNotifications = typeof req.body.emailOtherNotifications === 'boolean' ? req.body.emailOtherNotifications : undefined;

  const current = await prisma.company.findUnique({ where: { id: req.user.companyId } });
  if (!current) return res.status(404).json({ error: 'Company not found' });

  const identityChanged =
    (name !== undefined && name !== current.name) ||
    (registrationNumber !== undefined && (registrationNumber || null) !== (current.registrationNumber || null));
  const reverify = identityChanged && current.verificationStatus === 'VERIFIED';

  const company = await prisma.company.update({
    where: { id: current.id },
    data: {
      name, country, address, phone, emailNewRfq, emailOtherNotifications,
      registrationNumber: registrationNumber === undefined ? undefined : (registrationNumber || null),
      ...(reverify ? { verificationStatus: 'IN_REVIEW', verificationNotes: 'Re-verification required: company name or CR number changed' } : {}),
    },
  });
  res.json({ ...company, reverificationRequired: reverify });
});

// POST /api/companies/me/documents   body: { fileUrl: data: URL, docType }
// The file is checked (PDF or raster image by content, under 2MB) and stored in the private bucket;
// only admins can open it (GET /api/admin/companies/:id/documents/:docId).
const addDocument = asyncHandler(async (req, res) => {
  const { fileUrl, docType } = req.body;
  if (!fileUrl || !docType) return res.status(400).json({ error: 'fileUrl and docType required' });
  if (!DOC_TYPES.includes(docType)) return res.status(400).json({ error: 'docType must be one of ' + DOC_TYPES.join(', ') });
  const checked = checkDocument(fileUrl);
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (!storage.isConfigured()) return res.status(503).json({ error: 'File storage is not configured' });

  const storageKey = storage.newKey('companies/' + req.user.companyId);
  try {
    await storage.putObject(storageKey, checked.buffer, checked.contentType);
  } catch (err) {
    Sentry.captureException(err, { tags: { area: 'storage' }, extra: { companyId: req.user.companyId, storageKey } });
    console.error('storage put failed:', err.message);
    return res.status(502).json({ error: 'Could not store the file, please try again' });
  }

  const doc = await prisma.$transaction(async (tx) => {
    const created = await tx.companyDocument.create({
      data: { companyId: req.user.companyId, docType, storageKey, contentType: checked.contentType, sizeBytes: checked.buffer.length },
      select: DOC_META,
    });
    // a new document puts an unverified/rejected company into the admin's queue; it doesn't
    // un-verify an already verified one
    await tx.company.updateMany({
      where: { id: req.user.companyId, verificationStatus: { in: ['PENDING', 'REJECTED'] } },
      data: { verificationStatus: 'IN_REVIEW' },
    });
    return created;
  });
  res.status(201).json(doc);
});

// GET /api/admin/companies/:id/documents/:docId  (admin) - one document for review:
// { id, docType, uploadedAt, contentType, url } — url shows the file in the page for 120 seconds.
// Documents not yet moved to the bucket still come as { ..., fileUrl: data: URL }.
const getCompanyDocument = asyncHandler(async (req, res) => {
  const doc = await prisma.companyDocument.findFirst({ where: { id: req.params.docId, companyId: req.params.id } });
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.set('Cache-Control', 'no-store');
  const meta = { id: doc.id, companyId: doc.companyId, docType: doc.docType, uploadedAt: doc.uploadedAt };
  if (doc.storageKey) {
    if (!storage.isConfigured()) return res.status(503).json({ error: 'File storage is not configured' });
    return res.json({ ...meta, contentType: doc.contentType, url: await storage.presignView(doc.storageKey, doc.contentType), expiresIn: storage.DOWNLOAD_URL_TTL_SECONDS });
  }
  res.json({ ...meta, fileUrl: doc.fileUrl });
});

// GET /api/admin/companies?status=PENDING
const listCompanies = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const STATUSES = ['PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED'];
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be one of ' + STATUSES.join(', ') });
  }
  const companies = await prisma.company.findMany({
    where: status ? { verificationStatus: status } : undefined,
    include: { documents: { select: DOC_META, orderBy: { uploadedAt: 'desc' } }, user: { select: { email: true } }, wallet: { select: { balance: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(companies);
});

// PATCH /api/admin/companies/:id/verify   body: { status: 'VERIFIED'|'REJECTED', notes }
const setVerificationStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;
  if (!['VERIFIED', 'REJECTED', 'IN_REVIEW', 'PENDING'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const company = await prisma.company.update({
    where: { id },
    data: { verificationStatus: status, verificationNotes: notes },
  });
  if (status === 'VERIFIED' || status === 'REJECTED') {
    notify(company.id, 'VERIFICATION', status === 'VERIFIED' ? 'Company verified' : 'Verification rejected', notes || undefined);
  }
  res.json(company);
});

// POST /api/admin/companies/:id/reset-password  -> generates a temp password and returns it once
const resetCompanyPassword = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return res.status(404).json({ error: 'Company not found' });

  const tempPassword = crypto.randomBytes(6).toString('base64url'); // ~8 char random password
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  // also ends all of the user's existing sessions
  await prisma.user.update({ where: { id: company.userId }, data: { passwordHash, tokenVersion: { increment: 1 } } });

  res.json({ ok: true, tempPassword });
});

// DELETE /api/admin/companies/:id
// Without purchase orders involving other companies: permanently deletes the company, its user and its data.
// With them: keeps those shared records and deactivates + anonymizes the company instead (see below).
const deleteCompany = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return res.status(404).json({ error: 'Company not found' });

  const mode = await prisma.$transaction(async (tx) => {
    // Other suppliers paid to quote on this company's open RFQs: cancel them with refunds first
    const openRfqs = await tx.rFQ.findMany({ where: { buyerCompanyId: id, status: { in: CANCELLABLE_STATUSES } }, select: { id: true } });
    for (const { id: rfqId } of openRfqs) {
      await tx.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${rfqId} FOR UPDATE`;
      const rfq = await tx.rFQ.findUnique({ where: { id: rfqId } });
      if (CANCELLABLE_STATUSES.includes(rfq.status)) await cancelRfqInTx(tx, rfq);
    }
    await tx.quote.updateMany({ where: { supplierCompanyId: id, status: { in: ['SUBMITTED', 'SHORTLISTED'] } }, data: { status: 'WITHDRAWN' } });

    await tx.catalogItem.deleteMany({ where: { supplierCompanyId: id } });
    await tx.companyDocument.deleteMany({ where: { companyId: id } });
    await tx.notification.deleteMany({ where: { companyId: id } });

    const tradedWithOthers = await tx.lPO.count({ where: { OR: [{ buyerCompanyId: id }, { supplierCompanyId: id }] } });
    if (tradedWithOthers > 0) {
      // Purchase orders, orders, invoices, payments and messages are also the counterparties' records,
      // so they stay. The company is deactivated and stripped of personal/contact data instead.
      await tx.company.update({
        where: { id },
        data: { isActive: false, name: 'Deleted company', registrationNumber: null, country: null, address: null, phone: null, verificationNotes: null },
      });
      await tx.user.update({
        where: { id: company.userId },
        data: {
          isActive: false, email: `deleted-${company.userId}@deleted.invalid`, passwordHash: '!',
          verificationToken: null, verificationExpires: null, resetToken: null, resetExpires: null,
        },
      });
      return 'anonymized';
    }

    // No shared trading history: remove everything that belongs to this company only
    const ownRfqIds = (await tx.rFQ.findMany({ where: { buyerCompanyId: id }, select: { id: true } })).map((r) => r.id);
    // attachment rows go with their quotes (the stored files stay in the bucket, unreferenced)
    await tx.quoteAttachment.deleteMany({ where: { quote: { OR: [{ supplierCompanyId: id }, { rfqId: { in: ownRfqIds } }] } } });
    await tx.quote.deleteMany({ where: { OR: [{ supplierCompanyId: id }, { rfqId: { in: ownRfqIds } }] } });
    await tx.rFQ.deleteMany({ where: { buyerCompanyId: id } });
    const wallet = await tx.wallet.findUnique({ where: { companyId: id } });
    if (wallet) {
      await tx.walletTransaction.deleteMany({ where: { walletId: wallet.id } });
      await tx.wallet.delete({ where: { id: wallet.id } });
    }
    await tx.company.delete({ where: { id } });
    await tx.user.delete({ where: { id: company.userId } });
    return 'deleted';
  });

  res.json({
    ok: true,
    mode,
    message: mode === 'deleted'
      ? 'Company and all related data permanently deleted'
      : 'Company deactivated and anonymized; orders, invoices and payments shared with other companies were kept',
  });
});

module.exports = { getMyCompany, updateMyCompany, addDocument, getCompanyDocument, listCompanies, setVerificationStatus, resetCompanyPassword, deleteCompany };