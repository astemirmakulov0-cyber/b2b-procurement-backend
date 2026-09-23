const prisma = require('../config/prisma');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');
const { CANCELLABLE_STATUSES, cancelRfqInTx } = require('../utils/rfqCancel');

// GET /api/companies/me
const getMyCompany = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({
    where: { id: req.user.companyId },
    include: { documents: true, wallet: true },
  });
  res.json(company);
});

// PATCH /api/companies/me
const updateMyCompany = asyncHandler(async (req, res) => {
  const { name, country, address, phone, registrationNumber } = req.body;
  const company = await prisma.company.update({
    where: { id: req.user.companyId },
    data: { name, country, address, phone, registrationNumber },
  });
  res.json(company);
});

// POST /api/companies/me/documents
const addDocument = asyncHandler(async (req, res) => {
  const { fileUrl, docType } = req.body;
  if (!fileUrl || !docType) return res.status(400).json({ error: 'fileUrl and docType required' });
  const doc = await prisma.companyDocument.create({
    data: { companyId: req.user.companyId, fileUrl, docType },
  });
  // submitting a document moves verification into review
  await prisma.company.update({
    where: { id: req.user.companyId },
    data: { verificationStatus: 'IN_REVIEW' },
  });
  res.status(201).json(doc);
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
    include: { documents: true, user: { select: { email: true } }, wallet: { select: { balance: true } } },
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
  await prisma.user.update({ where: { id: company.userId }, data: { passwordHash } });

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

module.exports = { getMyCompany, updateMyCompany, addDocument, listCompanies, setVerificationStatus, resetCompanyPassword, deleteCompany };