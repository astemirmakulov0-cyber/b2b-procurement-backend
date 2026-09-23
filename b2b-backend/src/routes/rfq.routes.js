const router = require('express').Router();
const rfqCtrl = require('../controllers/rfq.controller');
const quoteCtrl = require('../controllers/quote.controller');
const lpoCtrl = require('../controllers/lpo.controller');
const { authRequired, requireRole } = require('../middleware/auth');

router.post('/rfqs', authRequired, requireRole('BUYER'), rfqCtrl.createRFQ);
router.get('/rfqs', authRequired, rfqCtrl.listRFQs);
router.get('/rfqs/:id', authRequired, rfqCtrl.getRFQ);
router.patch('/rfqs/:id', authRequired, requireRole('BUYER'), rfqCtrl.updateRFQ);
router.post('/rfqs/:id/cancel', authRequired, requireRole('BUYER'), rfqCtrl.cancelRFQ);

router.post('/rfqs/:rfqId/quotes', authRequired, requireRole('SUPPLIER'), quoteCtrl.submitQuote);
router.get('/rfqs/:rfqId/quotes', authRequired, quoteCtrl.listQuotesForRFQ);

router.patch('/quotes/:id/shortlist', authRequired, requireRole('BUYER'), quoteCtrl.shortlistQuote);
router.patch('/quotes/:id/reject', authRequired, requireRole('BUYER'), quoteCtrl.rejectQuote);
router.post('/quotes/:id/award', authRequired, requireRole('BUYER'), lpoCtrl.awardQuote);

module.exports = router;
