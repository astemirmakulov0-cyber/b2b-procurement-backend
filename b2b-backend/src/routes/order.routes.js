const router = require('express').Router();
const lpoCtrl = require('../controllers/lpo.controller');
const orderCtrl = require('../controllers/order.controller');
const paymentCtrl = require('../controllers/payment.controller');
const { authRequired, requireRole } = require('../middleware/auth');

// LPO
router.get('/lpos', authRequired, lpoCtrl.listLPOs);
router.patch('/lpos/:id/accept', authRequired, requireRole('SUPPLIER'), lpoCtrl.acceptLPO);
router.patch('/lpos/:id/decline', authRequired, requireRole('SUPPLIER'), lpoCtrl.declineLPO);

// Orders & delivery
router.get('/orders', authRequired, orderCtrl.listOrders);
router.get('/orders/:id', authRequired, orderCtrl.getOrder);
router.patch('/orders/:id/status', authRequired, orderCtrl.updateOrderStatus);
router.patch('/orders/:id/delivery', authRequired, requireRole('SUPPLIER'), orderCtrl.updateDelivery);

// Invoices & payments
router.get('/invoices', authRequired, paymentCtrl.listInvoices);
router.get('/invoices/:id', authRequired, paymentCtrl.getInvoice);
router.post('/invoices/:id/payments', authRequired, requireRole('BUYER'), paymentCtrl.recordPayment);

module.exports = router;
