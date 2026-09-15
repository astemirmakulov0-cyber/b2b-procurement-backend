const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/wallet
const getWallet = asyncHandler(async (req, res) => {
  const wallet = await prisma.wallet.findUnique({
    where: { companyId: req.user.companyId },
    include: { transactions: { orderBy: { createdAt: 'desc' }, take: 50 } },
  });
  res.json(wallet);
});

// POST /api/wallet/topup  body: { amount, reference }
// NOTE: in production this endpoint should be called only after a real payment gateway confirms the charge.
const topUp = asyncHandler(async (req, res) => {
  const { amount, reference } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.update({
      where: { companyId: req.user.companyId },
      data: { balance: { increment: amount } },
    });
    const transaction = await tx.walletTransaction.create({
      data: { walletId: wallet.id, amount, type: 'TOPUP', reference },
    });
    return { wallet, transaction };
  });

  res.status(201).json(result);
});

module.exports = { getWallet, topUp };
