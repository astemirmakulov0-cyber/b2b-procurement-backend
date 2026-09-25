const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');
const { MONEY_DECIMALS, MONEY_MAX, parseAmount, formatAmount } = require('../utils/money');
const { ATTACHMENT_SELECT } = require('./quoteAttachment.controller');

const BID_FEE_PERCENT = 0.05; // supplier pays 5% of the RFQ's budget to submit a quote

// POST /api/rfqs/:rfqId/quotes  (supplier, must be verified) - submits a bid, deducts 5% of RFQ budget from wallet
// body: { unitPrice, deliveryTimeDays } — the price per unit; the quote total (price) = unitPrice × the RFQ quantity.
// A body with only `price` (pages loaded before unit pricing, where that field was labelled "Unit price") is read as
// the unit price too.
const submitQuote = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.user.companyId } });
  if (!company || company.verificationStatus !== 'VERIFIED') {
    return res.status(403).json({ error: 'Your company must be verified before submitting quotes' });
  }

  const { rfqId } = req.params;
  const { currency, deliveryTimeDays, notes } = req.body;
  const parsedUnit = parseAmount(req.body.unitPrice !== undefined ? req.body.unitPrice : req.body.price, 'unitPrice');
  if (parsedUnit.error) return res.status(400).json({ error: parsedUnit.error });
  if (currency !== undefined && currency !== 'BHD') return res.status(400).json({ error: 'Only BHD is supported' });

  const fail = (status, message) => Object.assign(new Error(message), { status });

  const result = await prisma.$transaction(async (tx) => {
    // Lock the RFQ row: serialises submissions on this RFQ (so the duplicate check below is reliable)
    // and keeps it from being awarded/cancelled/edited while this quote is being charged for.
    await tx.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${rfqId} FOR UPDATE`;
    const rfq = await tx.rFQ.findUnique({ where: { id: rfqId } });
    if (!rfq || rfq.status !== 'PUBLISHED') throw fail(400, 'RFQ is not open for quotes');
    if (rfq.deadline && rfq.deadline <= new Date()) throw fail(400, 'The deadline for this RFQ has passed');
    if (!rfq.budget) throw fail(400, 'This RFQ has no budget set — cannot calculate bid fee');
    if (!rfq.quantity || rfq.quantity < 1) throw fail(400, 'This RFQ has no quantity — cannot calculate the quote total');
    // quantity is a whole number and the unit price has at most 3 decimals, so the total is exact in fils
    const total = parsedUnit.value.mul(rfq.quantity);
    if (total.gt(MONEY_MAX)) throw fail(400, 'The quote total (unit price × quantity) is too large');

    const alreadyQuoted = await tx.quote.findFirst({
      where: { rfqId, supplierCompanyId: req.user.companyId, status: { not: 'WITHDRAWN' } },
      select: { id: true },
    });
    if (alreadyQuoted) throw fail(409, 'You have already submitted a quote for this RFQ');

    // Round to the column's 3 decimals (fils) so the debit and the ledger entry match exactly
    const bidCost = rfq.budget.mul(BID_FEE_PERCENT).toDecimalPlaces(MONEY_DECIMALS);

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
        price: total,
        unitPrice: parsedUnit.value,
        currency: 'BHD',
        deliveryTimeDays,
        notes,
      },
    });
    return { quote, rfq };
  });

  res.status(201).json(result.quote);
  // after commit, so the buyer is only told about quotes that were actually stored
  notify(result.rfq.buyerCompanyId, 'NEW_QUOTE', 'New quote received',
    'A verified supplier quoted ' + formatAmount(result.quote.price) + ' BHD total (' + formatAmount(result.quote.unitPrice) + ' BHD × ' + result.rfq.quantity + ') on "' + result.rfq.title + '". Open Compare bids to review it.');
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
    include: {
      supplierCompany: { select: { id: true, name: true, verificationStatus: true } },
      // live attachments (a supplier only ever gets its own quote here)
      attachments: { where: { deletedAt: null }, select: ATTACHMENT_SELECT, orderBy: { createdAt: 'asc' } },
      // the LPO issued for this quote, with the supplier's reason if it was declined
      lpo: { select: { status: true, declineReason: true } },
    },
    orderBy: { price: 'asc' },
  });
  res.json(quotes);
});

// The buyer evaluates quotes while the RFQ is open for evaluation: PUBLISHED, or QUOTING_CLOSED (bidding
// closed but no winner yet — awarding is allowed there too, and a declined LPO returns the RFQ to it).
// AWARDED and CANCELLED RFQs are final.
const EVALUATION_RFQ_STATUSES = ['PUBLISHED', 'QUOTING_CLOSED'];

// Shared by shortlist/reject: `to` is the target status, `from` the statuses it may be reached from.
// Runs under the same RFQ row lock as award/cancel, so e.g. reject and award of one quote can't both win.
function changeQuoteStatus(to, from) {
  return asyncHandler(async (req, res) => {
    const quote = await prisma.quote.findUnique({ where: { id: req.params.id }, include: { rfq: true } });
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    if (quote.rfq.buyerCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${quote.rfqId} FOR UPDATE`;
      const rfq = await tx.rFQ.findUnique({ where: { id: quote.rfqId }, select: { status: true } });
      if (!EVALUATION_RFQ_STATUSES.includes(rfq.status)) {
        throw Object.assign(new Error(`Cannot change quotes of an RFQ in ${rfq.status} status`), { status: 400 });
      }
      const current = await tx.quote.findUnique({ where: { id: quote.id } });
      if (current.status === to) return { quote: current, changed: false }; // repeating the same action changes nothing
      if (!from.includes(current.status)) {
        throw Object.assign(new Error(`Cannot change a ${current.status} quote to ${to}`), { status: 400 });
      }
      return { quote: await tx.quote.update({ where: { id: quote.id }, data: { status: to } }), changed: true };
    });
    res.json(updated.quote);
    // after commit and only on a real change; RFQ title only — the buyer stays anonymous until award (M4)
    if (updated.changed) notifyQuoteStatus(quote.supplierCompanyId, to, quote.rfq.title);
  });
}

function notifyQuoteStatus(supplierCompanyId, status, rfqTitle) {
  if (status === 'SHORTLISTED') {
    notify(supplierCompanyId, 'QUOTE_SHORTLISTED', 'Your quote was shortlisted',
      'The buyer shortlisted your quote on "' + rfqTitle + '".');
  } else if (status === 'REJECTED') {
    notify(supplierCompanyId, 'QUOTE_REJECTED', 'Your quote was not selected',
      'The buyer did not select your quote on "' + rfqTitle + '".');
  }
}

// PATCH /api/quotes/:id/shortlist  (buyer)
const shortlistQuote = changeQuoteStatus('SHORTLISTED', ['SUBMITTED']);

// PATCH /api/quotes/:id/reject  (buyer)
const rejectQuote = changeQuoteStatus('REJECTED', ['SUBMITTED', 'SHORTLISTED']);

module.exports = { submitQuote, listQuotesForRFQ, shortlistQuote, rejectQuote, notifyQuoteStatus };