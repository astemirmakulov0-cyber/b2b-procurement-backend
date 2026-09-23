const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');

// POST /api/quotes/:id/award  (buyer) - awards the quote, closes RFQ, creates LPO + Order
const awardQuote = asyncHandler(async (req, res) => {
  const { terms } = req.body;
  const quote = await prisma.quote.findUnique({
    where: { id: req.params.id },
    include: { rfq: true },
  });
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (quote.rfq.buyerCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

  const result = await prisma.$transaction(async (tx) => {
    // Re-check status under a row lock so a concurrent cancel/award can't race this one
    const [rfq] = await tx.$queryRaw`SELECT status FROM "RFQ" WHERE id = ${quote.rfqId} FOR UPDATE`;
    if (!['PUBLISHED', 'QUOTING_CLOSED'].includes(rfq.status)) {
      throw Object.assign(new Error(`Cannot award an RFQ in ${rfq.status} status`), { status: 400 });
    }
    // re-read under the lock: the quote may have been withdrawn (e.g. supplier deactivated its account)
    const current = await tx.quote.findUnique({
      where: { id: quote.id },
      select: { status: true, supplierCompany: { select: { isActive: true } } },
    });
    if (!['SUBMITTED', 'SHORTLISTED'].includes(current.status) || !current.supplierCompany.isActive) {
      throw Object.assign(new Error('This quote can no longer be awarded'), { status: 400 });
    }

    await tx.quote.update({ where: { id: quote.id }, data: { status: 'AWARDED', statusBeforeAward: current.status } });
    // Auto-reject the other open quotes, remembering their status so a declined LPO can restore them.
    // Quotes already REJECTED/WITHDRAWN are left alone.
    for (const prev of ['SUBMITTED', 'SHORTLISTED']) {
      await tx.quote.updateMany({
        where: { rfqId: quote.rfqId, id: { not: quote.id }, status: prev },
        data: { status: 'REJECTED', statusBeforeAward: prev },
      });
    }
    await tx.rFQ.update({ where: { id: quote.rfqId }, data: { status: 'AWARDED' } });

    const lpo = await tx.lPO.create({
      data: {
        rfqId: quote.rfqId,
        quoteId: quote.id,
        buyerCompanyId: quote.rfq.buyerCompanyId,
        supplierCompanyId: quote.supplierCompanyId,
        totalAmount: quote.price,
        terms,
      },
    });

    return lpo;
  });

  res.status(201).json(result);
  notify(quote.supplierCompanyId, 'AWARDED', 'You won an order', 'Your quote on "' + quote.rfq.title + '" was awarded.');
});

// PATCH /api/lpos/:id/accept  (supplier) - supplier accepts LPO, creates Order
const acceptLPO = asyncHandler(async (req, res) => {
  const lpo = await prisma.lPO.findUnique({ where: { id: req.params.id } });
  if (!lpo) return res.status(404).json({ error: 'LPO not found' });
  if (lpo.supplierCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });
  if (lpo.status !== 'ISSUED') return res.status(400).json({ error: 'LPO not in issued state' });

  const result = await prisma.$transaction(async (tx) => {
    // conditional update: a concurrent decline/accept of the same LPO makes this one fail cleanly
    const { count } = await tx.lPO.updateMany({ where: { id: lpo.id, status: 'ISSUED' }, data: { status: 'ACCEPTED' } });
    if (count === 0) throw Object.assign(new Error('LPO not in issued state'), { status: 400 });
    const updated = await tx.lPO.findUnique({ where: { id: lpo.id } });
    const order = await tx.order.create({
      data: { lpoId: lpo.id, status: 'CONFIRMED' },
    });
    await tx.delivery.create({ data: { orderId: order.id } });
    await tx.invoice.create({ data: { orderId: order.id, amount: lpo.totalAmount } });
    return { lpo: updated, order };
  });

  res.json(result);
  notify(lpo.buyerCompanyId, 'ACCEPTED', 'Order confirmed', 'Your supplier accepted the purchase order.', result.order.id);
});
// PATCH /api/lpos/:id/decline  (supplier)  body: { reason? }
// Only an ISSUED (not yet accepted) LPO can be declined. The LPO is kept as DECLINED, the winning quote
// becomes REJECTED, the quotes auto-rejected by the award get their previous status back and the RFQ
// returns to QUOTING_CLOSED, so the buyer can award another quote (or cancel the RFQ).
const declineLPO = asyncHandler(async (req, res) => {
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
  const lpo = await prisma.lPO.findUnique({ where: { id: req.params.id }, include: { rfq: { select: { title: true } } } });
  if (!lpo) return res.status(404).json({ error: 'LPO not found' });
  if (lpo.supplierCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });
  if (lpo.status !== 'ISSUED') return res.status(400).json({ error: `Cannot decline an LPO in ${lpo.status} status` });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${lpo.rfqId} FOR UPDATE`;
    const { count } = await tx.lPO.updateMany({ where: { id: lpo.id, status: 'ISSUED' }, data: { status: 'DECLINED' } });
    if (count === 0) throw Object.assign(new Error('LPO is no longer in ISSUED status'), { status: 400 });

    await tx.quote.update({ where: { id: lpo.quoteId }, data: { status: 'REJECTED', statusBeforeAward: null } });
    for (const prev of ['SUBMITTED', 'SHORTLISTED']) {
      await tx.quote.updateMany({
        where: { rfqId: lpo.rfqId, status: 'REJECTED', statusBeforeAward: prev },
        data: { status: prev, statusBeforeAward: null },
      });
    }
    await tx.rFQ.update({ where: { id: lpo.rfqId }, data: { status: 'QUOTING_CLOSED' } });
    return tx.lPO.findUnique({ where: { id: lpo.id } });
  });

  res.json(updated);
  notify(lpo.buyerCompanyId, 'LPO_DECLINED', 'Purchase order declined',
    'The supplier declined the purchase order for "' + lpo.rfq.title + '". You can award another quote or cancel the RFQ.' +
    (reason ? ' Reason: ' + reason : ''));
});

// GET /api/lpos  - buyer or supplier's own LPOs
const listLPOs = asyncHandler(async (req, res) => {
  const where = req.user.role === 'SUPPLIER'
    ? { supplierCompanyId: req.user.companyId }
    : { buyerCompanyId: req.user.companyId };
  const lpos = await prisma.lPO.findMany({
    where,
    include: { rfq: { select: { title: true } }, order: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(lpos);
});

module.exports = { awardQuote, acceptLPO, declineLPO, listLPOs };
