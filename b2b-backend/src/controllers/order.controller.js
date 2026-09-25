const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');

async function loadOrderWithAccessCheck(orderId, user) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      lpo: { include: {
        buyerCompany: { select: { id: true, name: true } }, supplierCompany: { select: { id: true, name: true } }, rfq: { select: { title: true } },
      } },
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
// the buyer can only raise a dispute, while the order is still open and the goods not yet accepted
// (receipt is confirmed via POST /api/orders/:id/receipt, which closes disputes)
const BUYER_TRANSITIONS = {
  CONFIRMED: ['DISPUTED'], IN_PROGRESS: ['DISPUTED'], SHIPPED: ['DISPUTED'], DELIVERED: ['DISPUTED'],
};
// An admin leaves DISPUTED only via POST /api/admin/orders/:id/resolve-dispute (resume or cancel).

const MAX_COMMENT = 1000;
// Written by the server into the order chat; the admin dispute list reads the reason back by this prefix.
const DISPUTE_PREFIX = 'Dispute opened: ';

const statusLabel = (s) => s.toLowerCase().replace('_', ' ');

// Cancelling an order closes its invoice: pending payments fail, and an invoice without confirmed money
// is cancelled (one with confirmed money is kept as is — refunds are handled outside the platform).
// The caller holds the invoice row lock (the same lock as payments).
async function closeInvoiceOnCancel(tx, invoiceId) {
  await tx.payment.updateMany({
    where: { invoiceId, status: 'PENDING' },
    data: { status: 'FAILED', decidedAt: new Date(), rejectReason: 'Order cancelled' },
  });
  const confirmed = await tx.payment.count({ where: { invoiceId, status: 'COMPLETED' } });
  if (confirmed === 0) await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'CANCELLED' } });
}

// PATCH /api/orders/:id/status  body: { status, reason? }  (reason: the buyer opening a dispute)
const updateOrderStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be one of ' + ORDER_STATUSES.join(', ') });
  }
  if (req.user.role === 'ADMIN') {
    return res.status(400).json({ error: 'Admins change orders only by resolving a dispute' });
  }
  const reason = status === 'DISPUTED' && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length > MAX_COMMENT) return res.status(400).json({ error: `reason must be at most ${MAX_COMMENT} characters` });
  const { order, isSupplier, isBuyer, error } = await loadOrderWithAccessCheck(req.params.id, req.user);
  if (error) return res.status(error.status).json({ error: error.message });

  const table = isSupplier ? SUPPLIER_TRANSITIONS : isBuyer ? BUYER_TRANSITIONS : {};
  if (!(table[order.status] || []).includes(status)) {
    return res.status(400).json({ error: `Cannot change order status from ${order.status} to ${status}` });
  }
  if (status === 'DISPUTED' && order.receivedAt) {
    return res.status(400).json({ error: 'Receipt was confirmed: the order can no longer be disputed' });
  }
  if (status === 'CANCELLED' && isSupplier) {
    const paid = (order.invoice?.payments || []).some((p) => p.status === 'COMPLETED');
    if (paid) return res.status(400).json({ error: 'Cannot cancel an order that has payments' });
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Only apply if nobody changed the status since we read it; a dispute remembers where the order was
    // (a dispute also requires that receipt wasn't confirmed meanwhile)
    const data = status === 'DISPUTED' ? { status, statusBeforeDispute: order.status } : { status };
    const where = status === 'DISPUTED' ? { id: order.id, status: order.status, receivedAt: null } : { id: order.id, status: order.status };
    const { count } = await tx.order.updateMany({ where, data });
    if (count === 0) throw Object.assign(new Error('Order status changed meanwhile; reload and try again'), { status: 409 });
    if (status === 'DISPUTED' && reason) {
      await tx.message.create({ data: { orderId: order.id, senderCompanyId: req.user.companyId, body: DISPUTE_PREFIX + reason } });
    }
    if (status === 'CANCELLED' && order.invoice) {
      // same lock as payments, so no payment can be reported/confirmed while the invoice is being closed
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${order.invoice.id} FOR UPDATE`;
      if (isSupplier && await tx.payment.count({ where: { invoiceId: order.invoice.id, status: 'COMPLETED' } }) > 0) {
        throw Object.assign(new Error('Cannot cancel an order that has payments'), { status: 400 });
      }
      await closeInvoiceOnCancel(tx, order.invoice.id);
    }
    return tx.order.findUnique({ where: { id: order.id } });
  });
  res.json(updated);

  const other = isBuyer ? order.lpo.supplierCompanyId : order.lpo.buyerCompanyId;
  notify(other, 'ORDER_STATUS', 'Order ' + statusLabel(status), reason ? 'Reason: ' + reason.slice(0, 300) : undefined, order.id);
});

// GET /api/admin/orders?status=DISPUTED  (admin) - orders with both parties and, for disputes, the buyer's reason
const listOrdersAdmin = asyncHandler(async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be one of ' + ORDER_STATUSES.join(', ') });
  }
  const orders = await prisma.order.findMany({
    where: status ? { status } : {},
    include: {
      lpo: { select: {
        id: true, totalAmount: true, buyerCompanyId: true, rfq: { select: { title: true } },
        buyerCompany: { select: { id: true, name: true } }, supplierCompany: { select: { id: true, name: true } },
      } },
      delivery: true, invoice: true,
    },
    orderBy: { updatedAt: 'desc' },
  });
  // the reason is the latest dispute message written by the buyer (null if the buyer gave none)
  const reasons = orders.length === 0 ? [] : await prisma.message.findMany({
    where: { orderId: { in: orders.map((o) => o.id) }, body: { startsWith: DISPUTE_PREFIX } },
    select: { orderId: true, senderCompanyId: true, body: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders.map((o) => {
    const m = o.status === 'DISPUTED' && reasons.find((r) => r.orderId === o.id && r.senderCompanyId === o.lpo.buyerCompanyId);
    return { ...o, disputeReason: m ? m.body.slice(DISPUTE_PREFIX.length) : null };
  }));
});

// Where a resumed order goes when statusBeforeDispute is unknown (disputes opened before it was stored):
// the furthest status the delivery proves.
const STATUS_FROM_DELIVERY = { PENDING: 'CONFIRMED', DISPATCHED: 'SHIPPED', IN_TRANSIT: 'SHIPPED', FAILED: 'SHIPPED', DELIVERED: 'DELIVERED' };

// POST /api/admin/orders/:id/resolve-dispute  (admin)  body: { action: 'RESUME' | 'CANCEL', comment }
// RESUME returns the order to its status before the dispute (never COMPLETED: disputes happen before
// receipt, and an order completes only once received and paid); CANCEL cancels it like a normal
// cancellation. The comment goes to the order chat as an admin message and both parties are notified.
const resolveDispute = asyncHandler(async (req, res) => {
  const { action } = req.body;
  const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
  if (!['RESUME', 'CANCEL'].includes(action)) return res.status(400).json({ error: 'action must be RESUME or CANCEL' });
  if (!comment) return res.status(400).json({ error: 'comment required' });
  if (comment.length > MAX_COMMENT) return res.status(400).json({ error: `comment must be at most ${MAX_COMMENT} characters` });

  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lpo: true, invoice: true } });
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const result = await prisma.$transaction(async (tx) => {
    // invoice first, then order — the same lock order as confirming a payment
    if (order.invoice) await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${order.invoice.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
    const current = await tx.order.findUnique({ where: { id: order.id }, include: { invoice: true, delivery: true } });
    if (current.status !== 'DISPUTED') {
      throw Object.assign(new Error(`Order is ${current.status}, not DISPUTED`), { status: 400 });
    }

    let to;
    if (action === 'CANCEL') {
      to = 'CANCELLED';
      if (current.invoice) await closeInvoiceOnCancel(tx, current.invoice.id);
    } else {
      to = current.statusBeforeDispute || STATUS_FROM_DELIVERY[current.delivery?.status] || 'CONFIRMED';
    }
    await tx.order.update({ where: { id: order.id }, data: { status: to, statusBeforeDispute: null } });
    const verdict = action === 'CANCEL' ? 'order cancelled' : 'order resumed (' + statusLabel(to) + ')';
    await tx.message.create({ data: { orderId: order.id, senderCompanyId: null, body: 'Dispute resolved — ' + verdict + ': ' + comment } });
    return { order: await tx.order.findUnique({ where: { id: order.id } }), verdict };
  });
  res.json(result.order);

  for (const companyId of [order.lpo.buyerCompanyId, order.lpo.supplierCompanyId]) {
    notify(companyId, 'DISPUTE_RESOLVED', 'Dispute resolved: ' + result.verdict, comment.slice(0, 300), order.id);
  }
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

// Receipt can be confirmed once the goods are on their way or delivered (not while disputed).
const RECEIPT_FROM = ['SHIPPED', 'DELIVERED'];
const RECEIPT_TEXT = 'Receipt confirmed: all goods received in the agreed quantity and quality.';

// POST /api/orders/:id/receipt  (buyer)  body: { comment? }
// The buyer accepts the goods. Recorded with the time and posted to the order chat; the delivery is marked
// DELIVERED if the supplier hadn't; the invoice becomes payable (issuedAt = receipt time); disputes close.
// An invoice already fully paid (payments reported before receipt was required) completes the order here.
const confirmReceipt = asyncHandler(async (req, res) => {
  const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
  if (comment.length > MAX_COMMENT) return res.status(400).json({ error: `comment must be at most ${MAX_COMMENT} characters` });
  const { order, isBuyer, error } = await loadOrderWithAccessCheck(req.params.id, req.user);
  if (error) return res.status(error.status).json({ error: error.message });
  if (!isBuyer) return res.status(403).json({ error: 'Only the buyer can confirm receipt' });

  const result = await prisma.$transaction(async (tx) => {
    // invoice first, then order — the same lock order as payments and dispute resolution
    if (order.invoice) await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${order.invoice.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
    const current = await tx.order.findUnique({ where: { id: order.id }, include: { invoice: true, delivery: true } });
    if (current.receivedAt) throw Object.assign(new Error('Receipt was already confirmed'), { status: 400 });
    if (!RECEIPT_FROM.includes(current.status)) {
      throw Object.assign(new Error(`Receipt can be confirmed once the order is shipped (order is ${current.status})`), { status: 400 });
    }

    const now = new Date();
    if (current.delivery && current.delivery.status !== 'DELIVERED') {
      await tx.delivery.update({ where: { orderId: order.id }, data: { status: 'DELIVERED', deliveredAt: current.delivery.deliveredAt || now } });
    }
    const paid = current.invoice && current.invoice.status === 'PAID';
    if (current.invoice && current.invoice.status !== 'CANCELLED') {
      await tx.invoice.update({ where: { id: current.invoice.id }, data: { issuedAt: now } });
    }
    await tx.order.update({ where: { id: order.id }, data: { receivedAt: now, status: paid ? 'COMPLETED' : 'DELIVERED' } });
    await tx.message.create({ data: { orderId: order.id, senderCompanyId: req.user.companyId, body: RECEIPT_TEXT + (comment ? ' Note: ' + comment : '') } });
    return tx.order.findUnique({ where: { id: order.id } });
  });
  res.json(result);

  const title = order.lpo.rfq?.title;
  notify(order.lpo.supplierCompanyId, 'RECEIPT_CONFIRMED', 'Buyer confirmed receipt',
    'The buyer confirmed receipt' + (title ? ' of "' + title + '"' : '') + '. The invoice is now payable.' + (comment ? ' Note: ' + comment.slice(0, 200) : ''), order.id);
});

module.exports = { listOrders, getOrder, updateOrderStatus, updateDelivery, listOrdersAdmin, resolveDispute, confirmReceipt };
