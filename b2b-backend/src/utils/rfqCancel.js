const CANCELLABLE_STATUSES = ['DRAFT', 'PUBLISHED', 'QUOTING_CLOSED'];

// Cancels an RFQ inside the caller's transaction. The caller must already hold the RFQ row lock
// (SELECT ... FOR UPDATE) and have checked ownership and that rfq.status is cancellable.
// Marks it CANCELLED (the row is kept), rejects open quotes, refunds each supplier's bid fees for this
// RFQ from the ledger and notifies them. Returns { rfq, refunds }.
async function cancelRfqInTx(tx, rfq) {
  const updated = await tx.rFQ.update({ where: { id: rfq.id }, data: { status: 'CANCELLED' } });
  await tx.quote.updateMany({
    where: { rfqId: rfq.id, status: { in: ['SUBMITTED', 'SHORTLISTED'] } },
    data: { status: 'REJECTED' },
  });

  // Refund what the ledger says each supplier actually paid for this RFQ (BID_DEBIT entries are negative)
  const quotes = await tx.quote.findMany({ where: { rfqId: rfq.id }, select: { supplierCompanyId: true } });
  const supplierIds = [...new Set(quotes.map((q) => q.supplierCompanyId))];
  const refunds = [];
  for (const companyId of supplierIds) {
    const wallet = await tx.wallet.findUnique({ where: { companyId }, select: { id: true } });
    if (!wallet) continue;
    const { _sum } = await tx.walletTransaction.aggregate({
      where: { walletId: wallet.id, type: 'BID_DEBIT', reference: `RFQ ${rfq.id}` },
      _sum: { amount: true },
    });
    const refund = _sum.amount ? _sum.amount.neg() : null;
    if (refund && refund.gt(0)) {
      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: refund } } });
      await tx.walletTransaction.create({
        data: { walletId: wallet.id, amount: refund, type: 'REFUND', reference: `Refund: RFQ cancelled (RFQ ${rfq.id})` },
      });
    }
    await tx.notification.create({
      data: {
        companyId,
        type: 'RFQ_CANCELLED',
        title: 'RFQ cancelled',
        body: 'The buyer cancelled "' + rfq.title + '".' +
          (refund && refund.gt(0) ? ' Your bid fee of ' + refund.toFixed(2) + ' credits has been refunded.' : ''),
      },
    });
    refunds.push({ supplierCompanyId: companyId, amount: refund ? refund.toFixed(2) : '0.00' });
  }

  return { rfq: updated, refunds };
}

module.exports = { CANCELLABLE_STATUSES, cancelRfqInTx };
