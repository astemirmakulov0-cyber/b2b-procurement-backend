const router = require('express').Router();
const rfqCtrl = require('../controllers/rfq.controller');
const quoteCtrl = require('../controllers/quote.controller');
const attachmentCtrl = require('../controllers/quoteAttachment.controller');
const lpoCtrl = require('../controllers/lpo.controller');
const { authRequired, requireRole, requireNotSuspended } = require('../middleware/auth');

router.post('/rfqs', authRequired, requireRole('BUYER'), requireNotSuspended, rfqCtrl.createRFQ);
router.get('/rfqs', authRequired, rfqCtrl.listRFQs);
router.get('/rfqs/:id', authRequired, rfqCtrl.getRFQ);
router.patch('/rfqs/:id', authRequired, requireRole('BUYER'), requireNotSuspended, rfqCtrl.updateRFQ);
router.post('/rfqs/:id/cancel', authRequired, requireRole('BUYER'), rfqCtrl.cancelRFQ);

// Admin
router.get('/admin/rfqs', authRequired, requireRole('ADMIN'), rfqCtrl.listRFQsAdmin);

router.post('/rfqs/:rfqId/quotes', authRequired, requireRole('SUPPLIER'), requireNotSuspended, quoteCtrl.submitQuote);
router.get('/rfqs/:rfqId/quotes', authRequired, quoteCtrl.listQuotesForRFQ);

router.patch('/quotes/:id/shortlist', authRequired, requireRole('BUYER'), quoteCtrl.shortlistQuote);
router.patch('/quotes/:id/reject', authRequired, requireRole('BUYER'), quoteCtrl.rejectQuote);
router.post('/quotes/:id/award', authRequired, requireRole('BUYER'), lpoCtrl.awardQuote);

// Bid attachments (files in the private storage bucket)
router.get('/quotes/:id/attachments', authRequired, attachmentCtrl.listAttachments);
router.post('/quotes/:id/attachments', authRequired, requireRole('SUPPLIER'), attachmentCtrl.uploadAttachment);
router.get('/quote-attachments/:id/download', authRequired, attachmentCtrl.downloadAttachment);
router.delete('/quote-attachments/:id', authRequired, requireRole('SUPPLIER'), attachmentCtrl.deleteAttachment);

module.exports = router;
