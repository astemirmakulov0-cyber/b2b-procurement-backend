const router = require('express').Router();
const ctrl = require('../controllers/company.controller');
const analyticsCtrl = require('../controllers/adminAnalytics.controller');
const { authRequired, requireRole } = require('../middleware/auth');

router.get('/companies/me', authRequired, ctrl.getMyCompany);
router.patch('/companies/me', authRequired, ctrl.updateMyCompany);
router.post('/companies/me/documents', authRequired, ctrl.addDocument);

// Admin
router.get('/admin/companies', authRequired, requireRole('ADMIN'), ctrl.listCompanies);
router.get('/admin/companies/:id/documents/:docId', authRequired, requireRole('ADMIN'), ctrl.getCompanyDocument);
router.patch('/admin/companies/:id/verify', authRequired, requireRole('ADMIN'), ctrl.setVerificationStatus);
router.post('/admin/companies/:id/reset-password', authRequired, requireRole('ADMIN'), ctrl.resetCompanyPassword);
router.delete('/admin/companies/:id', authRequired, requireRole('ADMIN'), ctrl.deleteCompany);
router.post('/admin/companies/:id/deactivate', authRequired, requireRole('ADMIN'), ctrl.deactivateCompany);
router.post('/admin/companies/:id/reactivate', authRequired, requireRole('ADMIN'), ctrl.reactivateCompany);
router.get('/admin/analytics', authRequired, requireRole('ADMIN'), analyticsCtrl.getAnalytics);

module.exports = router;
