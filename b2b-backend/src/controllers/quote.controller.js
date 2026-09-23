const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');

const BID_FEE_PERCENT = 0.05; // supplier pays 5% of the RFQ's budget to submit a quote

// POST /api/rfqs/:rfqId/quotes  (supplier, must be verified) - submits a bid, deducts 5% of RFQ budget from wallet
const submitQuote = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.user.companyId } });
  if (!company || company.verificationStatus !== 'VERIFIED') {
    return res.status(403).json({ error: 'Your company must be verified before submitting quotes' });
  }

  const { rfqId } = req.params;
  const { price, currency, deliveryTimeDays, notes } = req.body;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'price must be a positive number' });
  }

  const fail = (status, message) => Object.assign(new Error(message), { status });

  const result = await prisma.$transaction(async (tx) => {
    // Lock the RFQ row: serialises submissions on this RFQ (so the duplicate check below is reliable)
    // and keeps it from being awarded/cancelled/edited while this quote is being charged for.
    await tx.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${rfqId} FOR UPDATE`;
    const rfq = await tx.rFQ.findUnique({ where: { id: rfqId } });
    if (!rfq || rfq.status !== 'PUBLISHED') throw fail(400, 'RFQ is not open for quotes');
    if (!rfq.budget) throw fail(400, 'This RFQ has no budget set — cannot calculate bid fee');

    const alreadyQuoted = await tx.quote.findFirst({
      where: { rfqId, supplierCompanyId: req.user.companyId, status: { not: 'WITHDRAWN' } },
      select: { id: true },
    });
    if (alreadyQuoted) throw fail(409, 'You have already submitted a quote for this RFQ');

    // Round to the column's 2 decimals so the debit and the ledger entry match exactly
    const bidCost = rfq.budget.mul(BID_FEE_PERCENT).toDecimalPlaces(2);

    // Conditional decrement: the balance check and the debit are one UPDATE, so two concurrent
    // bids can't both pass the check and push the balance negative.
    const { count } = await tx.wallet.updateMany({
      where: { companyId: req.user.companyId, balance: { gte: bidCost } },
      data: { balance: { decrement: bidCost } },
    });
    if (count === 0) throw fail(402, 'Insufficient bid credits');
    const wallet = await tx.wallet.findUnique({ where: { companyId: req.user.companyId }, select: { id: true } });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: bidCost.neg(),
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

// GET /api/rfqs/:rfqId/quotes  (buyer sees all offers to compare; supplier sees only their own)
const listQuotesForRFQ = asyncHandler(async (req, res) => {
  const rfq = await prisma.rFQ.findUnique({ where: { id: req.params.rfqId } });
  if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
  if (req.user.role === 'BUYER' && rfq.buyerCompanyId !== req.user.companyId) {
    return res.status(403).json({ error: 'Not your RFQ' });
  }

  const where = { rfqId: req.params.rfqId };
  if (req.user.role === 'SUPPLIER') {
    // suppliers must never see competitors' pricing on the same RFQ
    where.supplierCompanyId = req.user.companyId;
  }

  const quotes = await prisma.quote.findMany({
    where,
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