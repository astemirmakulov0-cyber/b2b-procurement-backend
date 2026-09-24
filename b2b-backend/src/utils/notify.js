const Sentry = require('@sentry/node');
const prisma = require('../config/prisma');

// Fire-and-forget: never let a notification failure break the calling request, but report it —
// a lost notification means a party silently misses an award, payment or message.
async function notify(companyId, type, title, body, relatedOrderId) {
  if (!companyId) return;
  try {
    await prisma.notification.create({
      data: { companyId, type, title, body, relatedOrderId: relatedOrderId || undefined },
    });
  } catch (err) {
    console.error(`notify(${type}) failed for company ${companyId}:`, err.message);
    Sentry.captureException(err, {
      tags: { area: 'notify', notificationType: type },
      extra: { companyId, relatedOrderId: relatedOrderId || null, title },
    });
  }
}

module.exports = { notify };
