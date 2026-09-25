// Public endpoints: no authentication. Mounted under /api, so the general API rate limiter applies.
const router = require('express').Router();
const publicCtrl = require('../controllers/public.controller');

router.get('/public/stats', publicCtrl.getStats);

module.exports = router;
