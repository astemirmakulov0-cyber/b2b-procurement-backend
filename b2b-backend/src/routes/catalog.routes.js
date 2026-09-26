const router = require('express').Router();
const catalogCtrl = require('../controllers/catalog.controller');
const walletCtrl = require('../controllers/wallet.controller');
const { authRequired, requireRole, requireNotSuspended } = require('../middleware/auth');

router.post('/catalog', authRequired, requireRole('SUPPLIER'), requireNotSuspended, catalogCtrl.createItem);
router.get('/catalog', authRequired, catalogCtrl.listItems);
router.patch('/catalog/:id', authRequired, requireRole('SUPPLIER'), requireNotSuspended, catalogCtrl.updateItem);
router.delete('/catalog/:id', authRequired, requireRole('SUPPLIER'), requireNotSuspended, catalogCtrl.deleteItem);

router.get('/wallet', authRequired, walletCtrl.getWallet);
// No payment gateway yet, so crediting a wallet is an admin-only operation
router.post('/wallet/topup', authRequired, requireRole('ADMIN'), walletCtrl.topUp);

module.exports = router;
