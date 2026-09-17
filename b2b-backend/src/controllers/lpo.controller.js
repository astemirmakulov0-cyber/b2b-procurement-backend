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
  if (quote.rfq.status === 'AWARDED') return res.status(400).json({ error: 'RFQ already awarded' });

  const result = await prisma.$transaction(async (tx) => {
    await tx.quote.update({ where: { id: quote.id }, data: { status: 'AWARDED' } });
    await tx.quote.updateMany({
      where: { rfqId: quote.rfqId, id: { not: quote.id } },
      data: { status: 'REJECTED' },
    });
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
    const updated = await tx.lPO.update({ where: { id: lpo.id }, data: { status: 'ACCEPTED' } });
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
// PATCH /api/lpos/:id/decline  (supplier)
const declineLPO = asyncHandler(async (req, res) => {
  const lpo = await prisma.lPO.findUnique({ where: { id: req.params.id } });
  if (!lpo) return res.status(404).json({ error: 'LPO not found' });
  if (lpo.supplierCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

  const updated = await prisma.lPO.update({ where: { id: lpo.id }, data: { status: 'DECLINED' } });
  res.json(updated);
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
