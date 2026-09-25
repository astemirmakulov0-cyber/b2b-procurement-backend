const Sentry = require('@sentry/node');
const prisma = require('../config/prisma');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const APP_URL = 'https://app.biddex.online';
const FROM = 'Biddex <noreply@biddex.online>';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Simple template: title, one line of body, an "Open in Biddex" button, a settings link. title/body come
// from notify() callers and may contain user-entered text (RFQ titles, dispute reasons), so both are escaped.
function emailHtml(title, body) {
  return '<div style="font-family:sans-serif;">' +
    '<p style="font-size:16px;font-weight:700;margin:0 0 8px;">' + escapeHtml(title) + '</p>' +
    (body ? '<p style="margin:0 0 20px;">' + escapeHtml(body) + '</p>' : '') +
    '<p style="margin:0 0 24px;"><a href="' + APP_URL + '" style="background:#0f172a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;">Open in Biddex</a></p>' +
    '<p style="margin:0;font-size:12px;color:#667;">Manage email notifications in <a href="' + APP_URL + '" style="color:#667;">Settings</a>.</p>' +
    '</div>';
}

// NEW_RFQ is the only event gated by "email about new RFQs"; every other notification type is gated by
// "other email notifications".
const prefFieldFor = (type) => (type === 'NEW_RFQ' ? 'emailNewRfq' : 'emailOtherNotifications');

// Fire-and-forget: never let a notification (or its email) failure break the calling request, but report it —
// a lost notification means a party silently misses an award, payment or message. Callers never `await`
// notify(), so the Resend network call here never delays the API response.
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

  try {
    const prefField = prefFieldFor(type);
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { [prefField]: true, user: { select: { email: true } } },
    });
    if (company && company[prefField] && company.user?.email) {
      const { error } = await resend.emails.send({ from: FROM, to: company.user.email, subject: title, html: emailHtml(title, body) });
      if (error) throw new Error('Resend error: ' + error.message);
    }
  } catch (err) {
    console.error(`notify email(${type}) failed for company ${companyId}:`, err.message);
    Sentry.captureException(err, { tags: { area: 'notify-email', notificationType: type }, extra: { companyId, title } });
  }
}

// New-RFQ fan-out: one in-app notification plus one email per verified, active supplier. Resend's batch
// endpoint (up to 100 messages per call) avoids hitting its per-second rate limit the way a loop of single
// sends would once there are more than a handful of suppliers.
const RESEND_BATCH_SIZE = 100;
async function notifyNewRfq(title, body) {
  let suppliers;
  try {
    suppliers = await prisma.company.findMany({
      where: { type: 'SUPPLIER', isActive: true, verificationStatus: 'VERIFIED' },
      select: { id: true, emailNewRfq: true, user: { select: { email: true } } },
    });
  } catch (err) {
    console.error('notifyNewRfq: failed to load suppliers:', err.message);
    Sentry.captureException(err, { tags: { area: 'notify', notificationType: 'NEW_RFQ' } });
    return;
  }
  if (suppliers.length === 0) return;

  try {
    await prisma.notification.createMany({ data: suppliers.map((s) => ({ companyId: s.id, type: 'NEW_RFQ', title, body })) });
  } catch (err) {
    console.error('notifyNewRfq: createMany failed:', err.message);
    Sentry.captureException(err, { tags: { area: 'notify', notificationType: 'NEW_RFQ' } });
  }

  const recipients = suppliers.filter((s) => s.emailNewRfq && s.user?.email).map((s) => s.user.email);
  const html = emailHtml(title, body);
  for (let i = 0; i < recipients.length; i += RESEND_BATCH_SIZE) {
    const chunk = recipients.slice(i, i + RESEND_BATCH_SIZE);
    try {
      const { error } = await resend.batch.send(chunk.map((to) => ({ from: FROM, to, subject: title, html })));
      if (error) throw new Error('Resend batch error: ' + error.message);
    } catch (err) {
      console.error('notifyNewRfq: email batch failed:', err.message);
      Sentry.captureException(err, { tags: { area: 'notify-email', notificationType: 'NEW_RFQ' }, extra: { batchStart: i, batchSize: chunk.length } });
    }
  }
}

module.exports = { notify, notifyNewRfq };
