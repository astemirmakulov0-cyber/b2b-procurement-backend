// Public, unauthenticated endpoints (the landing page at biddex.online).
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

// Below this a metric is returned as null (the landing hides it): small early numbers read as "empty"
const MIN_DISPLAY = { suppliers: 10, buyers: 10, rfqs: 10, quotes: 10 };
const CACHE_TTL_MS = 10 * 60 * 1000;

// Verified, active companies of a type, behind an active buyer/supplier account (admins have no company)
const countCompanies = (type) => prisma.company.count({
  where: { type, verificationStatus: 'VERIFIED', isActive: true, user: { isActive: true, role: type } },
});

// Counts only — no names, ids or amounts
async function computeStats() {
  const [suppliers, buyers, rfqs, quotes] = await Promise.all([
    countCompanies('SUPPLIER'),
    countCompanies('BUYER'),
    // RFQs ever published: there is no publish timestamp, so the statuses after publishing, plus cancelled
    // RFQs that received quotes (a draft can be cancelled too, but can't have quotes)
    prisma.rFQ.count({
      where: { OR: [{ status: { in: ['PUBLISHED', 'QUOTING_CLOSED', 'AWARDED'] } }, { status: 'CANCELLED', quotes: { some: {} } }] },
    }),
    // every quote ever submitted, whatever became of it
    prisma.quote.count(),
  ]);
  const raw = { suppliers, buyers, rfqs, quotes };
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v >= MIN_DISPLAY[k] ? v : null]));
}

// In-memory cache, 10 minutes. The pending promise is cached too, so a burst of requests runs the counts once.
let cache = null; // { expires, promise }
function cachedStats() {
  if (!cache || cache.expires <= Date.now()) {
    const promise = computeStats();
    cache = { expires: Date.now() + CACHE_TTL_MS, promise };
    promise.catch(() => { if (cache && cache.promise === promise) cache = null; }); // don't cache a failure
  }
  return cache.promise;
}

// GET /api/public/stats  (no auth) -> { suppliers, buyers, rfqs, quotes }: numbers, or null below MIN_DISPLAY
const getStats = asyncHandler(async (req, res) => {
  const stats = await cachedStats();
  res.set('Cache-Control', 'public, max-age=600').json(stats);
});

// tests only
const resetStatsCache = () => { cache = null; };

module.exports = { getStats, resetStatsCache, MIN_DISPLAY };
