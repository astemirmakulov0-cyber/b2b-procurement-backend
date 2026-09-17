const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/notifications
const listNotifications = asyncHandler(async (req, res) => {
  const notifications = await prisma.notification.findMany({
    where: { companyId: req.user.companyId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(notifications);
});

// PATCH /api/notifications/read-all
const markAllRead = asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({
    where: { companyId: req.user.companyId, read: false },
    data: { read: true },
  });
  res.json({ ok: true });
});

// PATCH /api/notifications/:id/read
const markOneRead = asyncHandler(async (req, res) => {
  const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!n || n.companyId !== req.user.companyId) return res.status(404).json({ error: 'Not found' });
  const updated = await prisma.notification.update({ where: { id: n.id }, data: { read: true } });
  res.json(updated);
});

module.exports = { listNotifications, markAllRead, markOneRead };
