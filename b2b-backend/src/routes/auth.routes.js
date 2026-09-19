const router = require('express').Router();
const ctrl = require('../controllers/auth.controller');
const { authRequired } = require('../middleware/auth');

router.post('/register', ctrl.register);
router.post('/login', ctrl.login);
router.get('/me', authRequired, ctrl.me);
router.patch('/password', authRequired, ctrl.changePassword);
router.delete('/me', authRequired, ctrl.deleteAccount);

module.exports = router;
