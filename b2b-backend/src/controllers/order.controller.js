const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');

async function loadOrderWithAccessCheck(orderId, user) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { lpo: true, delivery: true, invoice: { include: { payments: true } } },
  });
  if (!order) return { error: { status: 404, message: 'Order not found' } };
  const isBuyer = order.lpo.buyerCompanyId === user.companyId;
  const isSupplier = order.lpo.supplierCompanyId === user.companyId;
  if (!isBuyer && !isSupplier && user.role !== 'ADMIN') {
    return { error: { status: 403, message: 'Forbidden' } };
  }
  return { order, isBuyer, isSupplier };
}

// GET /api/orders
const listOrders = asyncHandler(async (req, res) => {
  const where = req.user.role === 'SUPPLIER'
    ? { lpo: { supplierCompanyId: req.user.companyId } }
    : { lpo: { buyerCompanyId: req.user.companyId } };
  const orders = await prisma.order.findMany({
    where,
    include: { lpo: { select: { totalAmount: true, rfq: { select: { title: true } } } }, delivery: true, invoice: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders);
});

// GET /api/orders/:id
const getOrder = asyncHandler(async (req, res) => {
  const { order, error } = await loadOrderWithAccessCheck(req.params.id, req.user);
  if (error) return res.status(error.status).json({ error: error.message });
  res.json(order);
});

// PATCH /api/orders/:id/status  (supplier updates lifecycle e.g. IN_PROGRESS, SHIPPED, COMPLETED)
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const { order, isSupplier, isBuyer, error } = await loadOrderWithAccessCheck(req.params.id, req.user);
  if (error) return res.status(error.status).json({ error: error.message });

  const allowed = ['IN_PROGRESS', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'invalid status' });
  if (status === 'DISPUTED' && !isBuyer) return res.status(403).json({ error: 'Only buyer can raise a dispute' });
  if (status !== 'DISPUTED' && !isSupplier) return res.status(403).json({ error: 'Only supplier can update lifecycle status' });

  const updated = await prisma.order.update({ where: { id: order.id }, data: { status } });
  res.json(updated);
});

// PATCH /api/orders/:id/delivery  (supplier) - update delivery status / tracking
const updateDelivery = asyncHandler(async (req, res) => {
  const { status, trackingInfo, notes } = req.body;
  const { order, isSupplier, error } = await loadOrderWithAccessCheck(req.params.id, req.user);
  if (error) return res.status(error.status).json({ error: error.message });
  if (!isSupplier) return res.status(403).json({ error: 'Only supplier can update delivery' });

  const data = { status, trackingInfo, notes };
  if (status === 'DISPATCHED') data.dispatchedAt = new Date();
  if (status === 'DELIVERED') data.deliveredAt = new Date();

  const delivery = await prisma.delivery.update({
    where: { orderId: order.id },
    data,
  });

  if (status === 'DELIVERED') {
    await prisma.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
  }

  res.json(delivery);
  const label = status === 'DISPATCHED' ? 'Your order has been dispatched' : status === 'DELIVERED' ? 'Your order has been delivered' : 'Delivery status updated';
  notify(order.lpo.buyerCompanyId, 'DELIVERY', label, trackingInfo ? 'Tracking: ' + trackingInfo : undefined, order.id);
});

module.exports = { listOrders, getOrder, updateOrderStatus, updateDelivery };
