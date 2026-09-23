const prisma = require('../config/prisma');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');

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

// DELETE /api/admin/companies/:id  — permanently deletes the company, its user, and everything linked to it
const deleteCompany = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) return res.status(404).json({ error: 'Company not found' });

  await prisma.$transaction(async (tx) => {
    const lpos = await tx.lPO.findMany({
      where: { OR: [{ buyerCompanyId: id }, { supplierCompanyId: id }] },
      include: { order: true },
    });
    const orderIds = lpos.filter(l => l.order).map(l => l.order.id);

    if (orderIds.length) {
      await tx.payment.deleteMany({ where: { invoice: { orderId: { in: orderIds } } } });
      await tx.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
      await tx.delivery.deleteMany({ where: { orderId: { in: orderIds } } });
      await tx.message.deleteMany({ where: { orderId: { in: orderIds } } });
      await tx.order.deleteMany({ where: { id: { in: orderIds } } });
    }

    await tx.lPO.deleteMany({ where: { OR: [{ buyerCompanyId: id }, { supplierCompanyId: id }] } });
    await tx.quote.deleteMany({ where: { OR: [{ supplierCompanyId: id }, { rfq: { buyerCompanyId: id } }] } });
    await tx.rFQ.deleteMany({ where: { buyerCompanyId: id } });
    await tx.catalogItem.deleteMany({ where: { supplierCompanyId: id } });
    await tx.companyDocument.deleteMany({ where: { companyId: id } });
    await tx.notification.deleteMany({ where: { companyId: id } });

    const wallet = await tx.wallet.findUnique({ where: { companyId: id } });
    if (wallet) {
      await tx.walletTransaction.deleteMany({ where: { walletId: wallet.id } });
      await tx.wallet.delete({ where: { id: wallet.id } });
    }

    await tx.company.delete({ where: { id } });
    await tx.user.delete({ where: { id: company.userId } });
  });

  res.json({ ok: true, message: 'Company and all related data permanently deleted' });
});

module.exports = { getMyCompany, updateMyCompany, addDocument, listCompanies, setVerificationStatus, resetCompanyPassword, deleteCompany };