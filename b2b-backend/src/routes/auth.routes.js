const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/auth.controller');
const { authRequired } = require('../middleware/auth');

// Guessing the current password with a stolen token: 5 wrong attempts per user per 15 minutes.
// Keyed by user (runs after authRequired), and only "Current password is incorrect" (401) counts —
// validation errors and successful changes don't use up the budget. Once exhausted the request is
// refused before the password is checked.
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => 'user:' + req.user.id,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many wrong password attempts. Please try again in 15 minutes.' },
});

router.post('/register', ctrl.register);
router.post('/login', ctrl.login);
router.get('/verify', ctrl.verifyEmail);
router.post('/resend-verification', ctrl.resendVerification);
router.post('/forgot-password', ctrl.forgotPassword);
router.post('/reset-password', ctrl.resetPassword);
router.get('/me', authRequired, ctrl.me);
router.patch('/password', authRequired, changePasswordLimiter, ctrl.changePassword);
router.delete('/me', authRequired, ctrl.deleteAccount);

module.exports = router;
