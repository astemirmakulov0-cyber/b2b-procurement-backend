const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

// POST /api/rfqs  (buyer, must be verified)
const createRFQ = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.user.companyId } });
  if (!company || company.verificationStatus !== 'VERIFIED') {
    return res.status(403).json({ error: 'Your company must be verified before posting RFQs' });
  }

  const { title, description, category, quantity, unit, deadline, publish, budget } = req.body;
  if (!title || !description) return res.status(400).json({ error: 'title and description required' });

  const rfq = await prisma.rFQ.create({
    data: {
      buyerCompanyId: req.user.companyId,
      title,
      description,
      category,
      quantity,
      unit,
      budget,
      deadline: deadline ? new Date(deadline) : null,
      status: publish ? 'PUBLISHED' : 'DRAFT',
    },
  });
  res.status(201).json(rfq);
});

// GET /api/rfqs  - buyers see their own; suppliers see published RFQs (with optional category filter for matching)
const listRFQs = asyncHandler(async (req, res) => {
  const { category, status } = req.query;
  let where = {};
  if (req.user.role === 'BUYER') {
    where.buyerCompanyId = req.user.companyId;
  } else if (req.user.role === 'SUPPLIER') {
    where.status = 'PUBLISHED';
    if (category) where.category = category;
  }
  if (status && req.user.role === 'BUYER') where.status = status;

  const rfqs = await prisma.rFQ.findMany({
    where,
    include: { _count: { select: { quotes: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rfqs);
});

// GET /api/rfqs/:id
const getRFQ = asyncHandler(async (req, res) => {
  const rfq = await prisma.rFQ.findUnique({
    where: { id: req.params.id },
    include: {
      quotes: { include: { supplierCompany: { select: { id: true, name: true } } } },
      buyerCompany: { select: { id: true, name: true } },
    },
  });
  if (!rfq) return res.status(404).json({ error: 'RFQ not found' });

  if (req.user.role === 'BUYER') {
    if (rfq.buyerCompanyId !== req.user.companyId) {
      return res.status(403).json({ error: 'Not your RFQ' });
    }
  } else if (req.user.role === 'SUPPLIER') {
    const ownQuote = rfq.quotes.find(q => q.supplierCompanyId === req.user.companyId);

    // suppliers can only see RFQs that are open, or ones they've already quoted on
    if (rfq.status !== 'PUBLISHED' && !ownQuote) {
      return res.status(403).json({ error: 'RFQ not available' });
    }

    // hide the buyer's identity until this supplier's quote has been awarded
    const isAwarded = ownQuote && ownQuote.status === 'AWARDED';
    if (!isAwarded) {
      rfq.buyerCompany = { id: rfq.buyerCompany.id, name: 'Hidden until awarded' };
    }

    // never expose competitors' quotes on this endpoint
    rfq.quotes = ownQuote ? [ownQuote] : [];
  }

  res.json(rfq);
});

// PATCH /api/rfqs/:id  (buyer, owner only) - update or publish/close
const updateRFQ = asyncHandler(async (req, res) => {
  const existing = await prisma.rFQ.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'RFQ not found' });
  if (existing.buyerCompanyId !== req.user.companyId) {
    return res.status(403).json({ error: 'Not your RFQ' });
  }
  const { title, description, category, quantity, unit, deadline, status } = req.body;
  const rfq = await prisma.rFQ.update({
    where: { id: req.params.id },
    data: {
      title, description, category, quantity, unit,
      deadline: deadline ? new Date(deadline) : undefined,
      status,
    },
  });
  res.json(rfq);
});

module.exports = { createRFQ, listRFQs, getRFQ, updateRFQ };