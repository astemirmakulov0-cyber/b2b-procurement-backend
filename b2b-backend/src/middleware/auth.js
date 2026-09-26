const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');

async function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.split(' ')[1];
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    // JWTs live for days, so check on every request that the account hasn't been deactivated since
    // and that the password hasn't been changed/reset since the token was issued
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { isActive: true, tokenVersion: true, company: { select: { isActive: true, suspendedAt: true, suspensionReason: true } } },
    });
    if (!user || !user.isActive || (user.company && !user.company.isActive)) {
      return res.status(401).json({ error: 'Account deactivated' });
    }
    if ((payload.tv || 0) !== user.tokenVersion) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    // an admin-suspended company can still log in and work on orders already in flight; requireNotSuspended
    // gates the actions that start something new (posting RFQs/quotes, editing the catalog)
    req.suspendedReason = user.company && user.company.suspendedAt ? (user.company.suspensionReason || 'Contact support for details') : null;
  } catch (err) {
    return next(err);
  }

  req.user = payload; // { id, role, companyId }
  next();
}

// Blocks actions a suspended company must not take (creating/editing RFQs, submitting quotes, editing the
// catalog) while still allowing it to work on orders already in flight. Must run after authRequired.
function requireNotSuspended(req, res, next) {
  if (req.suspendedReason) {
    return res.status(403).json({ error: 'Account suspended: ' + req.suspendedReason });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

module.exports = { authRequired, requireRole, requireNotSuspended };
