const router = require('express').Router();
const catalogCtrl = require('../controllers/catalog.controller');
const walletCtrl = require('../controllers/wallet.controller');
const { authRequired, requireRole } = require('../middleware/auth');

router.post('/catalog', authRequired, requireRole('SUPPLIER'), catalogCtrl.createItem);
router.get('/catalog', authRequired, catalogCtrl.listItems);
router.patch('/catalog/:id', authRequired, requireRole('SUPPLIER'), catalogCtrl.updateItem);
router.delete('/catalog/:id', authRequired, requireRole('SUPPLIER'), catalogCtrl.deleteItem);

router.get('/wallet', authRequired, walletCtrl.getWallet);
router.post('/wallet/topup', authRequired, walletCtrl.topUp);

module.exports = router;
