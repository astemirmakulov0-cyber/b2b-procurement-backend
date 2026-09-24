const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');

async function loadOrderWithAccessCheck(orderId, user) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      lpo: { include: { buyerCompany: { select: { id: true, name: true } }, supplierCompany: { select: { id: true, name: true } } } },
      delivery: true, invoice: { include: { payments: true } },
    },
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
    // LPO number and both company names for the order rows (buyer and supplier know each other once awarded)
    include: {
      lpo: { select: {
        id: true, totalAmount: true, rfq: { select: { title: true } },
        buyerCompany: { select: { id: true, name: true } }, supplierCompany: { select: { id: true, name: true } },
      } },
      delivery: true, invoice: true,
    },
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

// Order lifecycle. COMPLETED is set by payment (invoice fully PAID), not by hand; COMPLETED and CANCELLED are final.
const ORDER_STATUSES = ['CONFIRMED', 'IN_PROGRESS', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'DISPUTED', 'CANCELLED'];
const SUPPLIER_TRANSITIONS = {
  CONFIRMED: ['IN_PROGRESS', 'SHIPPED', 'CANCELLED'],
  IN_PROGRESS: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
};
// the buyer can only raise a dispute, while the order is still open
const BUYER_TRANSITIONS = {
  CONFIRMED: ['DISPUTED'], IN_PROGRESS: ['DISPUTED'], SHIPPED: ['DISPUTED'], DELIVERED: ['DISPUTED'],
};
// an admin resolves disputes
const ADMIN_TRANSITIONS = {
  DISPUTED: ['IN_PROGRESS', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED'],
};

// PATCH /api/orders/:id/status  body: { status }
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be one of ' + ORDER_STATUSES.join(', ') });
  }
  const { order, isSupplier, isBuyer, error } = await loadOrderWithAccessCheck(req.params.id, req.user);
  if (error) return res.status(error.status).json({ error: error.message });

  const table = req.user.role === 'ADMIN' ? ADMIN_TRANSITIONS : isSupplier ? SUPPLIER_TRANSITIONS : isBuyer ? BUYER_TRANSITIONS : {};
  if (!(table[order.status] || []).includes(status)) {
    return res.status(400).json({ error: `Cannot change order status from ${order.status} to ${status}` });
  }
  if (status === 'CANCELLED' && isSupplier) {
    const paid = (order.invoice?.payments || []).some((p) => p.status === 'COMPLETED');
    if (paid) return res.status(400).json({ error: 'Cannot cancel an order that has payments' });
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Only apply if nobody changed the status since we read it
    const { count } = await tx.order.updateMany({ where: { id: order.id, status: order.status }, data: { status } });
    if (count === 0) throw Object.assign(new Error('Order status changed meanwhile; reload and try again'), { status: 409 });
    if (status === 'CANCELLED' && order.invoice) {
      // same lock as payments, so no payment can be reported/confirmed while the invoice is being closed
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${order.invoice.id} FOR UPDATE`;
      if (isSupplier && await tx.payment.count({ where: { invoiceId: order.invoice.id, status: 'COMPLETED' } }) > 0) {
        throw Object.assign(new Error('Cannot cancel an order that has payments'), { status: 400 });
      }
      await tx.payment.updateMany({
        where: { invoiceId: order.invoice.id, status: 'PENDING' },
        data: { status: 'FAILED', decidedAt: new Date(), rejectReason: 'Order cancelled' },
      });
      // an invoice with confirmed money on it is kept as is (refunds are handled outside the platform)
      const confirmed = await tx.payment.count({ where: { invoiceId: order.invoice.id, status: 'COMPLETED' } });
      if (confirmed === 0) await tx.invoice.update({ where: { id: order.invoice.id }, data: { status: 'CANCELLED' } });
    }
    return tx.order.findUnique({ where: { id: order.id } });
  });
  res.json(updated);

  const other = isBuyer ? order.lpo.supplierCompanyId : order.lpo.buyerCompanyId;
  notify(other, 'ORDER_STATUS', 'Order ' + status.toLowerCase().replace('_', ' '), undefined, order.id);
  if (req.user.role === 'ADMIN') notify(order.lpo.supplierCompanyId, 'ORDER_STATUS', 'Order ' + status.toLowerCase().replace('_', ' '), undefined, order.id);
});

const DELIVERY_TRANSITIONS = {
  PENDING: ['DISPATCHED'],
  DISPATCHED: ['IN_TRANSIT', 'DELIVERED', 'FAILED'],
  IN_TRANSIT: ['DELIVERED', 'FAILED'],
  FAILED: ['DISPATCHED'],
  DELIVERED: [],
};

// PATCH /api/orders/:id/delivery  (supplier) - update delivery status and/or tracking/notes
const updateDelivery = asyncHandler(async (req, res) => {
  const { status, trackingInfo, notes } = req.body;
  if (status !== undefined && !Object.keys(DELIVERY_TRANSITIONS).includes(status)) {
    return res.status(400).json({ error: 'status must be one of ' + Object.keys(DELIVERY_TRANSITIONS).join(', ') });
  }
  const { order, isSupplier, error } = await loadOrderWithAccessCheck(req.params.id, req.user);
  if (error) return res.status(error.status).json({ error: error.message });
  if (!isSupplier) return res.status(403).json({ error: 'Only supplier can update delivery' });
  if (['CANCELLED', 'DISPUTED'].includes(order.status)) {
    return res.status(400).json({ error: `Cannot update delivery of a ${order.status} order` });
  }

  const current = order.delivery.status;
  if (status !== undefined && status !== current && !DELIVERY_TRANSITIONS[current].includes(status)) {
    return res.status(400).json({ error: `Cannot change delivery status from ${current} to ${status}` });
  }

  const data = { trackingInfo, notes };
  if (status !== undefined && status !== current) {
    data.status = status;
    if (status === 'DISPATCHED') data.dispatchedAt = new Date();
    if (status === 'DELIVERED') data.deliveredAt = new Date();
  }

  const delivery = await prisma.$transaction(async (tx) => {
    const { count } = await tx.delivery.updateMany({ where: { orderId: order.id, status: current }, data });
    if (count === 0) throw Object.assign(new Error('Delivery status changed meanwhile; reload and try again'), { status: 409 });
    // keep the order lifecycle in step, without moving it backwards (e.g. an already COMPLETED prepaid order)
    if (data.status === 'DISPATCHED' || data.status === 'IN_TRANSIT') {
      await tx.order.updateMany({ where: { id: order.id, status: { in: ['CONFIRMED', 'IN_PROGRESS'] } }, data: { status: 'SHIPPED' } });
    }
    if (data.status === 'DELIVERED') {
      await tx.order.updateMany({ where: { id: order.id, status: { in: ['CONFIRMED', 'IN_PROGRESS', 'SHIPPED'] } }, data: { status: 'DELIVERED' } });
    }
    return tx.delivery.findUnique({ where: { orderId: order.id } });
  });

  res.json(delivery);
  const label = status === 'DISPATCHED' ? 'Your order has been dispatched' : status === 'DELIVERED' ? 'Your order has been delivered' : 'Delivery status updated';
  notify(order.lpo.buyerCompanyId, 'DELIVERY', label, trackingInfo ? 'Tracking: ' + trackingInfo : undefined, order.id);
});

module.exports = { listOrders, getOrder, updateOrderStatus, updateDelivery };
