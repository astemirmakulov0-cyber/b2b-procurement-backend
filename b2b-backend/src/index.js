require('dotenv').config();
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN || 'https://5f4176689d4c5e00084fefe866440e25@o4512134873153536.ingest.de.sentry.io/4512134889078864',
  environment: process.env.NODE_ENV || 'development',
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const authRoutes = require('./routes/auth.routes');
const companyRoutes = require('./routes/company.routes');
const rfqRoutes = require('./routes/rfq.routes');
const orderRoutes = require('./routes/order.routes');
const catalogRoutes = require('./routes/catalog.routes');
const errorHandler = require('./middleware/errorHandler');
const rateLimit = require('express-rate-limit');

const app = express();
// Railway rewrites X-Forwarded-For to "<client IP>, <Railway edge IP>" and then connects through
// one more internal proxy, so trust two hops to make req.ip the real client IP for rate limiting.
// Don't use X-Envoy-External-Address: Railway passes client-supplied values through unchanged.
app.set('trust proxy', 2);

app.use(helmet());
app.use(cors({
  origin: [
    'https://biddex.online',
    'https://app.biddex.online',
    'https://www.biddex.online'
  ],
  credentials: true
}));
app.use(morgan('dev'));
// Parse JSON globally, but don't reject malformed bodies here: that would answer 400 before
// authRequired/requireRole run. asyncHandler rejects them once the request reaches a controller.
const jsonParser = express.json({ limit: '10mb' });
app.use((req, res, next) => jsonParser(req, res, (err) => {
  if (err && err.type === 'entity.parse.failed') {
    req.body = {};
    req.bodyParseError = err;
    return next();
  }
  next(err);
}));
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  // only failed attempts count, so a team logging in from one office IP isn't locked out
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' }
});
app.use('/api/auth/login', authLimiter);

// Separate from authLimiter: successful registrations must still count, since each one sends an email
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts, please try again later.' }
});
app.use('/api/auth/register', registerLimiter);

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests, please try again later.' }
});
app.use('/api/auth/forgot-password', forgotPasswordLimiter);

const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification email requests, please try again later.' }
});
app.use('/api/auth/resend-verification', resendVerificationLimiter);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api', companyRoutes);
app.use('/api', rfqRoutes);
app.use('/api', orderRoutes);
app.use('/api', catalogRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`B2B backend running on port ${PORT}`));
