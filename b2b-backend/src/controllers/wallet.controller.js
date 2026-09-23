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

// POST /api/wallet/topup  (admin)  body: { companyId, amount, reference }
// Admin-only manual credit until a real payment gateway confirms charges.
const topUp = asyncHandler(async (req, res) => {
  const { companyId, amount, reference } = req.body;
  if (!companyId) return res.status(400).json({ error: 'companyId required' });
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const existing = await prisma.wallet.findUnique({ where: { companyId } });
  if (!existing) return res.status(404).json({ error: 'Wallet not found' });

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.update({
      where: { companyId },
      data: { balance: { increment: amount } },
    });
    const transaction = await tx.walletTransaction.create({
      data: { walletId: wallet.id, amount, type: 'TOPUP', reference: reference || 'Admin credit' },
    });
    return { wallet, transaction };
  });

  res.status(201).json(result);
});

module.exports = { getWallet, topUp };
