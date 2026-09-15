const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

const BID_CREDIT_COST = 1.0; // cost per quote submission, adjust as needed

// POST /api/rfqs/:rfqId/quotes  (supplier) - submits a bid, deducts bid credit from wallet
const submitQuote = asyncHandler(async (req, res) => {
  const { rfqId } = req.params;
  const { price, currency, deliveryTimeDays, notes } = req.body;
  if (!price) return res.status(400).json({ error: 'price required' });

  const rfq = await prisma.rFQ.findUnique({ where: { id: rfqId } });
  if (!rfq || rfq.status !== 'PUBLISHED') {
    return res.status(400).json({ error: 'RFQ is not open for quotes' });
  }

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { companyId: req.user.companyId } });
    if (!wallet || Number(wallet.balance) < BID_CREDIT_COST) {
      throw Object.assign(new Error('Insufficient bid credits'), { status: 402 });
    }

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { decrement: BID_CREDIT_COST } },
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: -BID_CREDIT_COST,
        type: 'BID_DEBIT',
        reference: `RFQ ${rfqId}`,
      },
    });

    const quote = await tx.quote.create({
      data: {
        rfqId,
        supplierCompanyId: req.user.companyId,
        price,
        currency: currency || 'BHD',
        deliveryTimeDays,
        notes,
      },
    });
    return quote;
  });

  res.status(201).json(result);
});

// GET /api/rfqs/:rfqId/quotes  (buyer, owner) - compare offers
const listQuotesForRFQ = asyncHandler(async (req, res) => {
  const rfq = await prisma.rFQ.findUnique({ where: { id: req.params.rfqId } });
  if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
  if (req.user.role === 'BUYER' && rfq.buyerCompanyId !== req.user.companyId) {
    return res.status(403).json({ error: 'Not your RFQ' });
  }
  const quotes = await prisma.quote.findMany({
    where: { rfqId: req.params.rfqId },
    include: { supplierCompany: { select: { id: true, name: true, verificationStatus: true } } },
    orderBy: { price: 'asc' },
  });
  res.json(quotes);
});

// PATCH /api/quotes/:id/shortlist  (buyer)
const shortlistQuote = asyncHandler(async (req, res) => {
  const quote = await prisma.quote.findUnique({ where: { id: req.params.id }, include: { rfq: true } });
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (quote.rfq.buyerCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

  const updated = await prisma.quote.update({
    where: { id: req.params.id },
    data: { status: 'SHORTLISTED' },
  });
  res.json(updated);
});

// PATCH /api/quotes/:id/reject  (buyer)
const rejectQuote = asyncHandler(async (req, res) => {
  const quote = await prisma.quote.findUnique({ where: { id: req.params.id }, include: { rfq: true } });
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (quote.rfq.buyerCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

  const updated = await prisma.quote.update({
    where: { id: req.params.id },
    data: { status: 'REJECTED' },
  });
  res.json(updated);
});

module.exports = { submitQuote, listQuotesForRFQ, shortlistQuote, rejectQuote };
