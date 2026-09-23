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
      select: { isActive: true, tokenVersion: true, company: { select: { isActive: true } } },
    });
    if (!user || !user.isActive || (user.company && !user.company.isActive)) {
      return res.status(401).json({ error: 'Account deactivated' });
    }
    if ((payload.tv || 0) !== user.tokenVersion) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  } catch (err) {
    return next(err);
  }

  req.user = payload; // { id, role, companyId }
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

module.exports = { authRequired, requireRole };
