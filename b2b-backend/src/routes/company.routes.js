const router = require('express').Router();
const ctrl = require('../controllers/company.controller');
const { authRequired, requireRole } = require('../middleware/auth');

router.get('/companies/me', authRequired, ctrl.getMyCompany);
router.patch('/companies/me', authRequired, ctrl.updateMyCompany);
router.post('/companies/me/documents', authRequired, ctrl.addDocument);

// Admin
router.get('/admin/companies', authRequired, requireRole('ADMIN'), ctrl.listCompanies);
router.patch('/admin/companies/:id/verify', authRequired, requireRole('ADMIN'), ctrl.setVerificationStatus);
router.post('/admin/companies/:id/reset-password', authRequired, requireRole('ADMIN'), ctrl.resetCompanyPassword);

module.exports = router;
