const prisma = require('../config/prisma');

// Fire-and-forget: never let a notification failure break the calling request
async function notify(companyId, type, title, body, relatedOrderId) {
  if (!companyId) return;
  try {
    await prisma.notification.create({
      data: { companyId, type, title, body, relatedOrderId: relatedOrderId || undefined },
    });
  } catch (err) {
    console.error('notify() failed:', err.message);
  }
}

module.exports = { notify };
