const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');

const PAYMENT_METHODS = ['bank_transfer', 'cheque', 'cash', 'card', 'other'];
const fail = (status, message) => Object.assign(new Error(message), { status });

// Sums of confirmed and pending payments and what is still open on the invoice (all Decimal)
async function invoiceTotals(tx, invoice) {
  const sum = async (status) => (await tx.payment.aggregate({ where: { invoiceId: invoice.id, status }, _sum: { amount: true } }))._sum.amount || new Prisma.Decimal(0);
  const paid = await sum('COMPLETED');
  const pending = await sum('PENDING');
  return { paid, pending, outstanding: invoice.amount.minus(paid).minus(pending) };
}

// Locks the invoice row for the rest of the transaction, so concurrent payments/confirmations on the
// same invoice run one after another and always see each other's effect (M10).
async function lockInvoice(tx, invoiceId) {
  await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
  return tx.invoice.findUnique({ where: { id: invoiceId }, include: { order: { include: { lpo: true } } } });
}

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

// POST /api/invoices/:id/payments  (buyer)  body: { amount, method, reference }
// The buyer reports a payment they made; it stays PENDING until the supplier confirms it.
const recordPayment = asyncHandler(async (req, res) => {
  const { amount, method } = req.body;
  const reference = typeof req.body.reference === 'string' ? req.body.reference.trim() : '';
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  const amt = new Prisma.Decimal(amount);
  if (amt.decimalPlaces() > 2) return res.status(400).json({ error: 'amount can have at most 2 decimal places' });
  if (!PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({ error: 'method must be one of ' + PAYMENT_METHODS.join(', ') });
  }
  if (reference.length > 100) return res.status(400).json({ error: 'reference must be at most 100 characters' });

  const existing = await prisma.invoice.findUnique({ where: { id: req.params.id }, include: { order: { include: { lpo: true } } } });
  if (!existing) return res.status(404).json({ error: 'Invoice not found' });
  if (existing.order.lpo.buyerCompanyId !== req.user.companyId) {
    return res.status(403).json({ error: 'Only the buyer can pay this invoice' });
  }

  const result = await prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, existing.id);
    if (invoice.status === 'PAID') throw fail(400, 'This invoice is already paid');
    if (invoice.status === 'CANCELLED' || invoice.order.status === 'CANCELLED') throw fail(400, 'Cannot pay a cancelled invoice');

    const totals = await invoiceTotals(tx, invoice);
    if (totals.outstanding.lte(0)) {
      throw fail(400, 'Nothing left to pay: the rest of this invoice is awaiting the supplier\'s confirmation');
    }
    if (amt.gt(totals.outstanding)) {
      throw fail(400, `amount exceeds the outstanding balance of ${totals.outstanding.toFixed(2)}`);
    }

    const payment = await tx.payment.create({
      data: { invoiceId: invoice.id, amount: amt, method, reference: reference || null, status: 'PENDING' },
    });
    return { payment, invoice, totals: { paid: totals.paid, pending: totals.pending.plus(amt), outstanding: totals.outstanding.minus(amt) } };
  });

  res.status(201).json({ payment: result.payment, totals: result.totals });
  notify(result.invoice.order.lpo.supplierCompanyId, 'PAYMENT_REPORTED', 'Payment reported',
    'The buyer reports a payment of ' + amt.toFixed(2) + (reference ? ' (ref ' + reference + ')' : '') + '. Please confirm or reject it.',
    result.invoice.orderId);
});

// Loads a payment and checks the caller is the supplier of its order
async function loadForSupplier(paymentId, user) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { invoice: { include: { order: { include: { lpo: true } } } } } });
  if (!payment) return { error: [404, 'Payment not found'] };
  if (payment.invoice.order.lpo.supplierCompanyId !== user.companyId) return { error: [403, 'Only the supplier can confirm or reject payments'] };
  return { payment };
}

// PATCH /api/payments/:id/confirm  (supplier) - money received: counts towards the invoice
const confirmPayment = asyncHandler(async (req, res) => {
  const { payment, error } = await loadForSupplier(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const result = await prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, payment.invoiceId);
    if (invoice.status === 'CANCELLED') throw fail(400, 'This invoice is cancelled');
    const now = new Date();
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'COMPLETED', decidedAt: now, paidAt: now },
    });
    if (count === 0) throw fail(400, 'Only a pending payment can be confirmed');

    const { paid } = await invoiceTotals(tx, invoice);
    const status = paid.gte(invoice.amount) ? 'PAID' : 'PARTIALLY_PAID';
    const updatedInvoice = await tx.invoice.update({ where: { id: invoice.id }, data: { status } });
    if (status === 'PAID') {
      // a disputed order stays DISPUTED until an admin resolves it
      await tx.order.updateMany({ where: { id: invoice.orderId, status: { notIn: ['DISPUTED', 'CANCELLED'] } }, data: { status: 'COMPLETED' } });
    }
    return { payment: await tx.payment.findUnique({ where: { id: payment.id } }), invoice: updatedInvoice };
  });

  res.json(result);
  notify(payment.invoice.order.lpo.buyerCompanyId, 'PAYMENT_CONFIRMED', 'Payment confirmed',
    'The supplier confirmed your payment of ' + payment.amount.toFixed(2) + '.', payment.invoice.orderId);
});

// PATCH /api/payments/:id/reject  (supplier)  body: { reason? } - money not received
const rejectPayment = asyncHandler(async (req, res) => {
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 300) : '';
  const { payment, error } = await loadForSupplier(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const updated = await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, payment.invoiceId);
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'FAILED', decidedAt: new Date(), rejectReason: reason || null },
    });
    if (count === 0) throw fail(400, 'Only a pending payment can be rejected');
    return tx.payment.findUnique({ where: { id: payment.id } });
  });

  res.json(updated);
  notify(payment.invoice.order.lpo.buyerCompanyId, 'PAYMENT_REJECTED', 'Payment not confirmed',
    'The supplier did not confirm your payment of ' + payment.amount.toFixed(2) + (reason ? '. Reason: ' + reason : '.'), payment.invoice.orderId);
});

module.exports = { listInvoices, getInvoice, recordPayment, confirmPayment, rejectPayment, PAYMENT_METHODS };
