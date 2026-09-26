const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');

// `readOnlyAdmin`: an admin may read any order's chat (to judge a dispute) but writes to it only by
// resolving the dispute. Admins have no company, so without it they never match a party.
async function assertOrderAccess(orderId, user, readOnlyAdmin = false) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lpo: true },
  });
  if (!order) return { error: 404 };
  if (readOnlyAdmin && user.role === 'ADMIN') return { order };
  if (!user.companyId || (order.lpo.buyerCompanyId !== user.companyId && order.lpo.supplierCompanyId !== user.companyId)) {
    return { error: 403 };
  }
  return { order };
}

// GET /api/orders/:orderId/messages  (messages with senderCompany null are admin comments)
const listMessages = asyncHandler(async (req, res) => {
  const { order, error } = await assertOrderAccess(req.params.orderId, req.user, true);
  if (error) return res.status(error).json({ error: error === 404 ? 'Order not found' : 'Forbidden' });

  const messages = await prisma.message.findMany({
    where: { orderId: order.id },
    include: { senderCompany: { select: { id: true, name: true, isActive: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json(messages);
});

// POST /api/orders/:orderId/messages   body: { body }
const sendMessage = asyncHandler(async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });

  const { order, error } = await assertOrderAccess(req.params.orderId, req.user);
  if (error) return res.status(error).json({ error: error === 404 ? 'Order not found' : 'Forbidden' });

  const message = await prisma.message.create({
    data: { orderId: order.id, senderCompanyId: req.user.companyId, body: body.trim() },
    include: { senderCompany: { select: { id: true, name: true, isActive: true } } },
  });

  const recipientId = order.lpo.buyerCompanyId === req.user.companyId
    ? order.lpo.supplierCompanyId
    : order.lpo.buyerCompanyId;
  notify(recipientId, 'MESSAGE', 'New message', body.trim().slice(0, 120), order.id);

  res.status(201).json(message);
});

module.exports = { listMessages, sendMessage };
