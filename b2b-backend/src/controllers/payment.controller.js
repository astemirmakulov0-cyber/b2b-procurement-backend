const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');

// GET /api/invoices
const listInvoices = asyncHandler(async (req, res) => {
  const where = req.user.role === 'SUPPLIER'
    ? { order: { lpo: { supplierCompanyId: req.user.companyId } } }
    : { order: { lpo: { buyerCompanyId: req.user.companyId } } };
  const invoices = await prisma.invoice.findMany({
    where,
    include: { payments: true, order: { include: { lpo: { select: { rfq: { select: { title: true } } } } } } },
    orderBy: { issuedAt: 'desc' },
  });
  res.json(invoices);
});

// GET /api/invoices/:id
const getInvoice = asyncHandler(async (req, res) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: { payments: true, order: { include: { lpo: true } } },
  });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  const isBuyer = invoice.order.lpo.buyerCompanyId === req.user.companyId;
  const isSupplier = invoice.order.lpo.supplierCompanyId === req.user.companyId;
  if (!isBuyer && !isSupplier) return res.status(403).json({ error: 'Forbidden' });
  res.json(invoice);
});

// POST /api/invoices/:id/payments  (buyer records/initiates a payment)
const recordPayment = asyncHandler(async (req, res) => {
  const { amount, method } = req.body;
  if (!amount) return res.status(400).json({ error: 'amount required' });

  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: { payments: true, order: { include: { lpo: true } } },
  });
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.order.lpo.buyerCompanyId !== req.user.companyId) {
    return res.status(403).json({ error: 'Only the buyer can pay this invoice' });
  }
  if (invoice.order.status === 'CANCELLED') {
    return res.status(400).json({ error: 'Cannot pay an invoice of a cancelled order' });
  }

  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: { invoiceId: invoice.id, amount, method, status: 'COMPLETED', paidAt: new Date() },
    });

    const paidTotal = invoice.payments
      .filter((p) => p.status === 'COMPLETED')
      .reduce((sum, p) => sum + Number(p.amount), 0) + Number(amount);

    const newStatus = paidTotal >= Number(invoice.amount) ? 'PAID' : 'PARTIALLY_PAID';
    const updatedInvoice = await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: newStatus },
    });

    if (newStatus === 'PAID') {
      // a disputed order stays DISPUTED until an admin resolves it
      await tx.order.updateMany({ where: { id: invoice.orderId, status: { notIn: ['DISPUTED', 'CANCELLED'] } }, data: { status: 'COMPLETED' } });
    }

    return { payment, invoice: updatedInvoice };
  });

  res.status(201).json(result);
  notify(invoice.order.lpo.supplierCompanyId, 'PAYMENT', 'Payment received', amount + ' received on invoice.', invoice.orderId);
});

module.exports = { listInvoices, getInvoice, recordPayment };
