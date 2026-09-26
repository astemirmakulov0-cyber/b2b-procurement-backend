const Sentry = require('@sentry/node');
const prisma = require('../config/prisma');
const { notify } = require('./notify');

// Runs inside the same always-on process (no separate Railway service needed): invoices only ever become
// OVERDUE here, once, via a conditional update — so a concurrent run (or the startup run overlapping the
// first hourly tick) can't double-notify. dueDate is only set once receipt is confirmed (see
// order.controller.js confirmReceipt), so an invoice can never be OVERDUE before that.
const UNPAID_STATUSES = ['ISSUED', 'PARTIALLY_PAID'];

async function checkOverdueInvoices() {
  let candidates;
  try {
    candidates = await prisma.invoice.findMany({
      where: { status: { in: UNPAID_STATUSES }, dueDate: { lt: new Date() } },
      select: {
        id: true,
        order: { select: { id: true, lpo: { select: { buyerCompanyId: true, supplierCompanyId: true, rfq: { select: { title: true } } } } } },
      },
    });
  } catch (err) {
    console.error('checkOverdueInvoices: failed to load candidates:', err.message);
    Sentry.captureException(err, { tags: { area: 'overdue-check' } });
    return;
  }

  for (const invoice of candidates) {
    try {
      // conditional: only the run that actually flips ISSUED/PARTIALLY_PAID -> OVERDUE notifies
      const { count } = await prisma.invoice.updateMany({
        where: { id: invoice.id, status: { in: UNPAID_STATUSES } },
        data: { status: 'OVERDUE' },
      });
      if (count === 0) continue;

      const title = invoice.order?.lpo?.rfq?.title;
      const body = 'The invoice for "' + (title || 'your order') + '" is now overdue.';
      for (const companyId of [invoice.order?.lpo?.buyerCompanyId, invoice.order?.lpo?.supplierCompanyId]) {
        notify(companyId, 'INVOICE_OVERDUE', 'Invoice overdue', body, invoice.order?.id);
      }
    } catch (err) {
      console.error('checkOverdueInvoices: failed for invoice ' + invoice.id + ':', err.message);
      Sentry.captureException(err, { tags: { area: 'overdue-check' }, extra: { invoiceId: invoice.id } });
    }
  }
}

module.exports = { checkOverdueInvoices };
