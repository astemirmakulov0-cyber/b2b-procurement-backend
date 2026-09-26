const { CANCELLABLE_STATUSES, cancelRfqInTx } = require('./rfqCancel');
const { formatAmount } = require('./money');

// Order statuses that still need this company's attention before its account can be erased.
const ACTIVE_ORDER_STATUSES = ['CONFIRMED', 'IN_PROGRESS', 'SHIPPED', 'DELIVERED'];
const UNPAID_INVOICE_STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'];

// PDPL erasure ("Delete account") is blocked while the company still has anything in flight with a
// counterparty: those records can't be anonymized without also affecting the other side's view of them.
// Returns { blockers: string[], walletBalance: string }.
async function getErasureBlockers(prisma, companyId) {
  const lpos = await prisma.lPO.findMany({
    where: { OR: [{ buyerCompanyId: companyId }, { supplierCompanyId: companyId }] },
    select: {
      order: { select: { status: true, invoice: { select: { status: true, payments: { select: { status: true } } } } } },
    },
  });

  let activeOrders = 0, disputedOrders = 0, unpaidInvoices = 0, pendingPayments = 0;
  for (const { order } of lpos) {
    if (!order) continue;
    if (order.status === 'DISPUTED') disputedOrders++;
    else if (ACTIVE_ORDER_STATUSES.includes(order.status)) activeOrders++;
    if (order.invoice && UNPAID_INVOICE_STATUSES.includes(order.invoice.status)) unpaidInvoices++;
    if (order.invoice) pendingPayments += order.invoice.payments.filter((p) => p.status === 'PENDING').length;
  }

  const blockers = [];
  if (activeOrders > 0) blockers.push(`${activeOrders} active order(s) not yet completed or cancelled`);
  if (disputedOrders > 0) blockers.push(`${disputedOrders} order(s) with an open dispute`);
  if (unpaidInvoices > 0) blockers.push(`${unpaidInvoices} unpaid invoice(s)`);
  if (pendingPayments > 0) blockers.push(`${pendingPayments} payment(s) awaiting confirmation`);

  const wallet = await prisma.wallet.findUnique({ where: { companyId }, select: { balance: true } });
  return { blockers, walletBalance: wallet ? formatAmount(wallet.balance) : formatAmount(0) };
}

// Anonymizes the user's personal data and the company's contact details, inside the caller's transaction.
// Company.name/registrationNumber/country are kept: counterparties' LPOs, orders and invoices still need
// the legal entity's identity. Returns the storage keys (verification documents, catalog photos) whose
// bucket objects must be deleted after the transaction commits.
async function eraseAccountInTx(tx, user, company) {
  const companyId = company.id;

  // Buyer side: cancel this company's own open RFQs (refunds suppliers' bid fees, notifies them)
  const openRfqs = await tx.rFQ.findMany({ where: { buyerCompanyId: companyId, status: { in: CANCELLABLE_STATUSES } }, select: { id: true } });
  for (const { id: rfqId } of openRfqs) {
    await tx.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${rfqId} FOR UPDATE`;
    const rfq = await tx.rFQ.findUnique({ where: { id: rfqId } });
    if (CANCELLABLE_STATUSES.includes(rfq.status)) await cancelRfqInTx(tx, rfq);
  }

  // Supplier side: withdraw this company's own pending quotes and tell each RFQ's buyer
  const pendingQuotes = await tx.quote.findMany({
    where: { supplierCompanyId: companyId, status: { in: ['SUBMITTED', 'SHORTLISTED'] } },
    select: { id: true, rfq: { select: { id: true, title: true, buyerCompanyId: true } } },
  });
  for (const quote of pendingQuotes) {
    await tx.quote.update({ where: { id: quote.id }, data: { status: 'WITHDRAWN' } });
    await tx.notification.create({
      data: {
        companyId: quote.rfq.buyerCompanyId,
        type: 'QUOTE_WITHDRAWN',
        title: 'A quote was withdrawn',
        body: `A supplier's quote for "${quote.rfq.title}" was withdrawn because the supplier closed its account.`,
      },
    });
  }

  const documents = await tx.companyDocument.findMany({ where: { companyId }, select: { storageKey: true } });
  const catalogItems = await tx.catalogItem.findMany({ where: { supplierCompanyId: companyId }, select: { imageKey: true } });
  const storageKeys = [...documents.map((d) => d.storageKey), ...catalogItems.map((c) => c.imageKey)].filter(Boolean);

  await tx.catalogItem.deleteMany({ where: { supplierCompanyId: companyId } });
  await tx.companyDocument.deleteMany({ where: { companyId } });
  await tx.notification.deleteMany({ where: { companyId } });

  // Remaining credits are lost (the user is warned before confirming), but the transaction history
  // (top-ups, bid debits, refunds) is bookkeeping, not personal data, and stays — only the balance is zeroed.
  await tx.wallet.updateMany({ where: { companyId }, data: { balance: 0 } });

  await tx.company.update({
    where: { id: companyId },
    data: { isActive: false, deletedAt: new Date(), phone: null, address: null, verificationNotes: null },
  });
  await tx.user.update({
    where: { id: user.id },
    data: {
      isActive: false,
      email: `deleted-${user.id}@deleted.invalid`,
      passwordHash: '!',
      tokenVersion: { increment: 1 },
      verificationToken: null, verificationExpires: null, resetToken: null, resetExpires: null,
    },
  });

  return { storageKeys };
}

module.exports = { getErasureBlockers, eraseAccountInTx };
