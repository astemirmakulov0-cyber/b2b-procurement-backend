const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const crypto = require('crypto');
const Sentry = require('@sentry/node');
const { CANCELLABLE_STATUSES, cancelRfqInTx } = require('../utils/rfqCancel');
const { normalizeEmail, emailError, passwordError } = require('../utils/credentials');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendVerificationEmail(email, token) {
  const verifyUrl = (process.env.FRONTEND_URL || 'http://localhost') + '/verify.html?token=' + token;
  // Resend resolves with { error } on API failures instead of throwing.
  const { error } = await resend.emails.send({
    from: 'Biddex <noreply@biddex.online>',
    to: email,
    subject: 'Verify your Biddex account',
    html: '<p>Welcome to Biddex. Please verify your email by clicking the link below:</p><p><a href="' + verifyUrl + '">Verify my email</a></p><p>This link expires in 24 hours.</p>'
  });
  if (error) throw new Error('Resend error: ' + error.message);
}

async function sendPasswordResetEmail(email, token) {
  const resetUrl = (process.env.FRONTEND_URL || 'http://localhost') + '/reset-password.html?token=' + token;
  // Resend resolves with { error } on API failures instead of throwing.
  const { error } = await resend.emails.send({
    from: 'Biddex <noreply@biddex.online>',
    to: email,
    subject: 'Reset your Biddex password',
    html: '<p>We received a request to reset your Biddex password. Click the link below to choose a new one:</p><p><a href="' + resetUrl + '">Reset my password</a></p><p>This link expires in 1 hour. If you did not request a password reset, you can ignore this email.</p>'
  });
  if (error) throw new Error('Resend error: ' + error.message);
}

// tv = the user's tokenVersion at signing time; authRequired rejects the token once it has been bumped
function signToken(user, companyId) {
  return jwt.sign(
    { id: user.id, role: user.role, companyId: companyId || null, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/register
// body: { email, password, role: 'BUYER'|'SUPPLIER', companyName, country }
const register = asyncHandler(async (req, res) => {
  const { password, role, companyName, country, phone, registrationNumber, consent } = req.body;
  const email = normalizeEmail(req.body.email);

  if (!email || !password || !role || !companyName) {
    return res.status(400).json({ error: 'email, password, role and companyName are required' });
  }
  const invalid = emailError(email) || passwordError(password);
  if (invalid) return res.status(400).json({ error: invalid });
  if (!['BUYER', 'SUPPLIER'].includes(role)) {
    return res.status(400).json({ error: 'role must be BUYER or SUPPLIER' });
  }
  if (consent !== true) {
    return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy' });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const passwordHash = await bcrypt.hash(password, 10);
  const verificationToken = crypto.randomBytes(32).toString('hex');
  const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role,
      emailVerified: false,
      verificationToken,
      verificationExpires,
      company: {
        create: {
          name: companyName,
          type: role,
          country,
          phone,
          registrationNumber,
          consentAt: new Date(),
          wallet: { create: { balance: 0 } },
        },
      },
    },
    include: { company: true },
  });

  // The account is already created, so a failed send shouldn't fail the request; report it instead.
  try {
    await sendVerificationEmail(email, verificationToken);
  } catch (err) {
    console.error('Failed to send verification email:', err);
    Sentry.captureException(err);
  }
  res.status(201).json({
  message: 'Registration successful. Please check your email to verify your account before logging in.',
});
}); 

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { password } = req.body;
  const email = normalizeEmail(req.body.email);
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const user = await prisma.user.findUnique({ where: { email }, include: { company: true } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  if (!user.emailVerified) {
   return res.status(403).json({ error: 'Please verify your email before logging in' });
}

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  // checked after the password so the deactivated state isn't revealed to someone without it
  if (!user.isActive || (user.company && !user.company.isActive)) {
    return res.status(403).json({ error: 'This account has been deactivated' });
  }

  const token = signToken(user, user.company?.id);
  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role },
    company: user.company,
  });
});

// GET /api/auth/me
const me = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    include: { company: { include: { wallet: true, documents: true } } },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, email: user.email, role: user.role, company: user.company });
});

// PATCH /api/auth/password  (self-service, requires current password)
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  const invalid = passwordError(newPassword, 'newPassword');
  if (invalid) return res.status(400).json({ error: invalid });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  // bumping tokenVersion logs out every other session; this one gets a fresh token
  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, tokenVersion: { increment: 1 }, resetToken: null, resetExpires: null },
  });
  res.json({ ok: true, token: signToken(updated, req.user.companyId) });
});

// DELETE /api/auth/me  (soft-delete: deactivate own account)
// Existing tokens stop working immediately (authRequired checks isActive). A buyer's open RFQs are
// cancelled with bid-fee refunds; a supplier's open quotes are withdrawn so they can't be awarded.
const deleteAccount = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { company: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  let cancelledRfqs = 0;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { isActive: false } });
    if (!user.company) return;
    const companyId = user.company.id;
    await tx.company.update({ where: { id: companyId }, data: { isActive: false } });

    const openRfqs = await tx.rFQ.findMany({
      where: { buyerCompanyId: companyId, status: { in: CANCELLABLE_STATUSES } },
      select: { id: true },
    });
    for (const { id } of openRfqs) {
      await tx.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${id} FOR UPDATE`;
      const rfq = await tx.rFQ.findUnique({ where: { id } });
      if (!CANCELLABLE_STATUSES.includes(rfq.status)) continue; // awarded meanwhile
      await cancelRfqInTx(tx, rfq);
      cancelledRfqs++;
    }

    await tx.quote.updateMany({
      where: { supplierCompanyId: companyId, status: { in: ['SUBMITTED', 'SHORTLISTED'] } },
      data: { status: 'WITHDRAWN' },
    });
  });

  res.json({ ok: true, message: 'Account deactivated successfully', cancelledRfqs });
});
 
// GET /api/auth/verify?token=...
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  const user = await prisma.user.findUnique({ where: { verificationToken: token } });
  if (!user) return res.status(400).json({ error: 'Invalid or expired token' });

  // Idempotent: if an email scanner already "clicked" this link, the real
  // user's click should still succeed instead of hitting a stale token.
  if (user.emailVerified) {
    return res.json({ ok: true, message: 'Email already verified' });
  }

  if (user.verificationExpires && user.verificationExpires < new Date()) {
    return res.status(400).json({ error: 'Token has expired' });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
    },
  });

  res.json({ ok: true, message: 'Email verified successfully' });
});

// POST /api/auth/forgot-password
// body: { email }
const forgotPassword = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'email is required' });

  const user = await prisma.user.findUnique({ where: { email } });
  // Always respond the same way so the endpoint can't be used to probe which emails exist.
  if (!user) return res.json({ ok: true });

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetExpires = new Date(Date.now() + 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: { resetToken, resetExpires },
  });

  // A failed send must not change the response, otherwise it reveals that the email exists.
  try {
    await sendPasswordResetEmail(user.email, resetToken);
  } catch (err) {
    console.error('Failed to send password reset email:', err);
    Sentry.captureException(err);
  }
  res.json({ ok: true });
});

// POST /api/auth/reset-password
// body: { token, newPassword }
const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword are required' });
  }
  const invalid = passwordError(newPassword, 'newPassword');
  if (invalid) return res.status(400).json({ error: invalid });

  const user = await prisma.user.findUnique({ where: { resetToken: token } });
  if (!user) return res.status(400).json({ error: 'Invalid or expired token' });

  if (!user.resetExpires || user.resetExpires < new Date()) {
    return res.status(400).json({ error: 'Token has expired' });
  }

  // tokenVersion bump: whoever held the old password (or a stolen token) is logged out everywhere
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, resetToken: null, resetExpires: null, tokenVersion: { increment: 1 } },
  });

  res.json({ ok: true, message: 'Password has been reset successfully' });
});

// POST /api/auth/resend-verification
// body: { email }
const resendVerification = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'email is required' });

  const user = await prisma.user.findUnique({ where: { email } });
  // Same response whether the user is missing, already verified or not, so emails can't be probed.
  if (!user || user.emailVerified) return res.json({ ok: true });

  const verificationToken = crypto.randomBytes(32).toString('hex');
  const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: { verificationToken, verificationExpires },
  });

  try {
    await sendVerificationEmail(user.email, verificationToken);
  } catch (err) {
    console.error('Failed to resend verification email:', err);
    Sentry.captureException(err);
  }
  res.json({ ok: true });
});

module.exports = { register, login, me, changePassword, deleteAccount, verifyEmail, forgotPassword, resetPassword, resendVerification };