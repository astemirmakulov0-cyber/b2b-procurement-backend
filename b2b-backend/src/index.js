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
// Railway's edge proxy sits in front of the app; trust one hop so req.ip is the client IP
// (otherwise rate limits key on rotating internal proxy IPs and never trigger).
app.set('trust proxy', 1);

// TEMP: diagnose which proxy hops Railway adds, to pick the right trust proxy setting. Remove after.
app.use('/api/health', (req, res, next) => {
  console.log('[ip-debug]', JSON.stringify({
    url: req.originalUrl,
    ip: req.ip,
    ips: req.ips,
    xff: req.headers['x-forwarded-for'],
    xRealIp: req.headers['x-real-ip'],
    envoyExternal: req.headers['x-envoy-external-address'],
    remote: req.socket.remoteAddress,
  }));
  next();
});

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
app.use(express.json({ limit: '10mb' }));
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
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

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
