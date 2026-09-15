const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

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
  const companies = await prisma.company.findMany({
    where: status ? { verificationStatus: status } : undefined,
    include: { documents: true, user: { select: { email: true } } },
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
  res.json(company);
});

module.exports = { getMyCompany, updateMyCompany, addDocument, listCompanies, setVerificationStatus };
