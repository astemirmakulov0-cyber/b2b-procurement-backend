const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { formatAmount } = require('../utils/money');

const VERIFICATION_STATUSES = ['PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED'];

// RFQs that were published at some point: the current statuses that only follow a publish, plus a
// cancelled RFQ that received quotes (same rule as the public landing stats).
function rfqsPublishedWhere(createdAt) {
  return {
    createdAt,
    OR: [
      { status: { in: ['PUBLISHED', 'QUOTING_CLOSED', 'AWARDED'] } },
      { status: 'CANCELLED', quotes: { some: {} } },
    ],
  };
}

// One window's numbers (createdAt undefined means "all time").
async function computeWindow(createdAt) {
  const zero = new Prisma.Decimal(0);
  const [rfqsPublished, quotesSubmitted, lposIssued, completedOrders, debits, refunds] = await Promise.all([
    prisma.rFQ.count({ where: rfqsPublishedWhere(createdAt) }),
    prisma.quote.count({ where: { createdAt } }),
    prisma.lPO.count({ where: { createdAt } }),
    prisma.order.findMany({ where: { status: 'COMPLETED', updatedAt: createdAt }, select: { lpo: { select: { totalAmount: true } } } }),
    prisma.walletTransaction.aggregate({ where: { type: 'BID_DEBIT', createdAt }, _sum: { amount: true } }),
    prisma.walletTransaction.aggregate({ where: { type: 'REFUND', createdAt }, _sum: { amount: true } }),
  ]);
  const completedOrdersAmount = completedOrders.reduce((sum, o) => sum.plus(o.lpo.totalAmount), zero);
  const debited = (debits._sum.amount || zero).neg(); // BID_DEBIT amounts are stored negative
  const refunded = refunds._sum.amount || zero;
  const bidFeeRevenue = debited.minus(refunded);
  return {
    rfqsPublished,
    quotesSubmitted,
    lposIssued,
    completedOrdersAmount: formatAmount(completedOrdersAmount),
    bidFeeRevenue: formatAmount(bidFeeRevenue),
  };
}

// GET /api/admin/analytics  (admin) - companies by verification status (current), plus RFQs published,
// quotes submitted, LPOs issued, completed-order total (BHD) and bid-fee revenue (BHD) for 7d/30d/all-time.
const getAnalytics = asyncHandler(async (req, res) => {
  const now = Date.now();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [statusCounts, w7d, w30d, wAll] = await Promise.all([
    Promise.all(VERIFICATION_STATUSES.map((s) => prisma.company.count({ where: { verificationStatus: s } }))),
    computeWindow({ gte: since7d }),
    computeWindow({ gte: since30d }),
    computeWindow(undefined),
  ]);

  res.json({
    companiesByStatus: Object.fromEntries(VERIFICATION_STATUSES.map((s, i) => [s, statusCounts[i]])),
    windows: { '7d': w7d, '30d': w30d, all: wAll },
  });
});

module.exports = { getAnalytics };
