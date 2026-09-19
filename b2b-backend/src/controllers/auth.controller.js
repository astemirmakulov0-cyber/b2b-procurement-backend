const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const crypto = require('crypto');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendVerificationEmail(email, token) {
  const verifyUrl = (process.env.FRONTEND_URL || 'http://localhost') + '/verify.html?token=' + token;
  await resend.emails.send({
    from: 'Biddex <onboarding@resend.dev>',
    to: email,
    subject: 'Verify your Biddex account',
    html: '<p>Welcome to Biddex. Please verify your email by clicking the link below:</p><p><a href="' + verifyUrl + '">Verify my email</a></p><p>This link expires in 24 hours.</p>'
  });
}

function signToken(user, companyId) {
  return jwt.sign(
    { id: user.id, role: user.role, companyId: companyId || null },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/register
// body: { email, password, role: 'BUYER'|'SUPPLIER', companyName, country }
const register = asyncHandler(async (req, res) => {
  const { email, password, role, companyName, country, phone, registrationNumber, consent } = req.body;

  if (!email || !password || !role || !companyName) {
    return res.status(400).json({ error: 'email, password, role and companyName are required' });
  }
  if (!['BUYER', 'SUPPLIER'].includes(role)) {
    return res.status(400).json({ error: 'role must be BUYER or SUPPLIER' });
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
          consentAt: consent ? new Date() : null,
          wallet: { create: { balance: 0 } },
        },
      },
    },
    include: { company: true },
  });

  await sendVerificationEmail(email, verificationToken);
  const token = signToken(user, user.company.id);
  res.status(201).json({
    token,
    user: { id: user.id, email: user.email, role: user.role },
    company: user.company,
    message: 'Registration successful. Please check your email to verify your account.',
  });
});

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const user = await prisma.user.findUnique({ where: { email }, include: { company: true } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  if (!user.emailVerified) {
   return res.status(403).json({ error: 'Please verify your email before logging in' });
}

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

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
  if (newPassword.length < 6) return res.status(400).json({ error: 'newPassword must be at least 6 characters' });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
  res.json({ ok: true });
});

// DELETE /api/auth/me  (soft-delete: deactivate own account)
const deleteAccount = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { company: true } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.company) {
    await prisma.company.update({
      where: { id: user.company.id },
      data: { isActive: false },
    });
  }

  res.json({ ok: true, message: 'Account deactivated successfully' });
});
 
// GET /api/auth/verify?token=...
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  const user = await prisma.user.findUnique({ where: { verificationToken: token } });
  if (!user) return res.status(400).json({ error: 'Invalid or expired token' });

  if (user.verificationExpires && user.verificationExpires < new Date()) {
    return res.status(400).json({ error: 'Token has expired' });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerified: true,
      verificationToken: null,
      verificationExpires: null,
    },
  });

  res.json({ ok: true, message: 'Email verified successfully' });
});

module.exports = { register, login, me, changePassword, deleteAccount, verifyEmail };
