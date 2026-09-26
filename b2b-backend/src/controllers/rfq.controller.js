const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { CANCELLABLE_STATUSES, cancelRfqInTx } = require('../utils/rfqCancel');
const { parseAmount } = require('../utils/money');
const { checkCategory } = require('../utils/categories');
const { notifyNewRfq } = require('../utils/notify');

const BUDGET_REQUIRED = 'budget is required to publish an RFQ (suppliers pay 5% of it to submit a quote)';
const QUANTITY_REQUIRED = 'quantity (a whole number, at least 1) is required to publish an RFQ (quotes are priced per unit)';
const validQuantity = (q) => Number.isInteger(q) && q >= 1;
const CATEGORY_REQUIRED = 'category is required to publish an RFQ';
const MAX_SPECIFICATIONS = 2000;
// { value } — trimmed text, or null for empty — or { error }; undefined when the field wasn't sent
function parseSpecifications(raw) {
  if (raw === undefined) return { value: undefined };
  if (raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: 'specifications must be text' };
  const text = raw.trim();
  if (text.length > MAX_SPECIFICATIONS) return { error: `specifications must be at most ${MAX_SPECIFICATIONS} characters` };
  return { value: text || null };
}

// Returns { date } for a valid future deadline, { error } otherwise
function parseDeadline(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: 'deadline is not a valid date' };
  if (date <= new Date()) return { error: 'deadline must be in the future' };
  return { date };
}

// POST /api/rfqs  (buyer, must be verified)
const createRFQ = asyncHandler(async (req, res) => {
  const company = await prisma.company.findUnique({ where: { id: req.user.companyId } });
  if (!company || company.verificationStatus !== 'VERIFIED') {
    return res.status(403).json({ error: 'Your company must be verified before posting RFQs' });
  }

  const { title, description, quantity, unit, deadline, publish } = req.body;
  const specs = parseSpecifications(req.body.specifications);
  if (specs.error) return res.status(400).json({ error: specs.error });
  // only active categories (others are "coming soon"); earlier names are mapped to the current one
  let category;
  if (req.body.category !== undefined && req.body.category !== null && req.body.category !== '') {
    const checked = checkCategory(req.body.category);
    if (checked.error) return res.status(400).json({ error: checked.error });
    category = checked.value;
  }
  if (!title || !description) return res.status(400).json({ error: 'title and description required' });
  let budget = null;
  if (req.body.budget !== undefined && req.body.budget !== null) {
    const parsed = parseAmount(req.body.budget, 'budget');
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    budget = parsed.value;
  }
  // The bid fee is 5% of the budget, so a published RFQ without one could never receive a quote
  if (publish && budget === null) return res.status(400).json({ error: BUDGET_REQUIRED });
  // quotes are priced per unit (total = unit price × quantity), so a published RFQ needs a quantity
  if (publish && !validQuantity(quantity)) return res.status(400).json({ error: QUANTITY_REQUIRED });
  if (publish && !category) return res.status(400).json({ error: CATEGORY_REQUIRED });
  let deadlineDate = null;
  if (deadline) {
    const parsed = parseDeadline(deadline);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    deadlineDate = parsed.date;
  }

  const rfq = await prisma.rFQ.create({
    data: {
      buyerCompanyId: req.user.companyId,
      title,
      description,
      category,
      quantity,
      unit,
      budget,
      specifications: specs.value || null,
      deadline: deadlineDate,
      status: publish ? 'PUBLISHED' : 'DRAFT',
    },
  });
  res.status(201).json(rfq);
  if (rfq.status === 'PUBLISHED') notifyNewRfq('New RFQ in ' + rfq.category, rfq.title);
});

// GET /api/rfqs  - buyers see their own; suppliers see published RFQs (with optional category filter for matching)
const listRFQs = asyncHandler(async (req, res) => {
  const { category, status } = req.query;
  const RFQ_STATUSES = ['DRAFT', 'PUBLISHED', 'QUOTING_CLOSED', 'AWARDED', 'CANCELLED'];
  if (status !== undefined && !RFQ_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be one of ' + RFQ_STATUSES.join(', ') });
  }
  let where = {};
  if (req.user.role === 'BUYER') {
    where.buyerCompanyId = req.user.companyId;
  } else if (req.user.role === 'SUPPLIER') {
    where.status = 'PUBLISHED';
    if (category) where.category = category;
  }
  if (status && req.user.role === 'BUYER') where.status = status;

  if (req.user.role === 'SUPPLIER') {
    // don't show RFQs of deactivated buyers — nobody will ever award them
    where.buyerCompany = { isActive: true };
    const rfqs = await prisma.rFQ.findMany({
      where,
      // only the supplier's own quote, so the UI knows which RFQs it has already bid on
      include: { quotes: { where: { supplierCompanyId: req.user.companyId }, select: {
        id: true, status: true, price: true, unitPrice: true, createdAt: true,
        _count: { select: { attachments: { where: { deletedAt: null } } } }, // own attachments only
      } } },
      orderBy: { createdAt: 'desc' },
    });
    // The buyer stays anonymous until award (no buyerCompanyId, which would let suppliers group RFQs
    // by buyer), and the number of competing quotes isn't disclosed.
    return res.json(rfqs.map(({ buyerCompanyId, ...rfq }) => rfq));
  }

  const rfqs = await prisma.rFQ.findMany({
    where,
    include: { _count: { select: { quotes: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(rfqs);
});

// GET /api/rfqs/:id
const getRFQ = asyncHandler(async (req, res) => {
  const rfq = await prisma.rFQ.findUnique({
    where: { id: req.params.id },
    include: {
      quotes: { include: { supplierCompany: { select: { id: true, name: true, isActive: true } } } },
      buyerCompany: { select: { id: true, name: true, isActive: true } },
    },
  });
  if (!rfq) return res.status(404).json({ error: 'RFQ not found' });

  if (req.user.role === 'BUYER') {
    if (rfq.buyerCompanyId !== req.user.companyId) {
      return res.status(403).json({ error: 'Not your RFQ' });
    }
  } else if (req.user.role === 'SUPPLIER') {
    const ownQuote = rfq.quotes.find(q => q.supplierCompanyId === req.user.companyId);

    // suppliers can only see RFQs that are open, or ones they've already quoted on
    if (rfq.status !== 'PUBLISHED' && !ownQuote) {
      return res.status(403).json({ error: 'RFQ not available' });
    }

    // never expose competitors' quotes on this endpoint
    rfq.quotes = ownQuote ? [ownQuote] : [];

    // hide the buyer's identity (name and id) until this supplier's quote has been awarded
    const isAwarded = ownQuote && ownQuote.status === 'AWARDED';
    if (!isAwarded) {
      const { buyerCompanyId, buyerCompany, ...anonymous } = rfq;
      return res.json({ ...anonymous, buyerCompany: { name: 'Hidden until awarded' } });
    }
  }

  res.json(rfq);
});

// Status changes a buyer may make via PATCH. AWARDED is only reachable via POST /quotes/:id/award and
// CANCELLED only via POST /rfqs/:id/cancel (which refunds bid fees); both are final.
const BUYER_STATUS_TRANSITIONS = {
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['QUOTING_CLOSED'],
  QUOTING_CLOSED: [],
  AWARDED: [],
  CANCELLED: [],
};
const CONTENT_FIELDS = ['title', 'description', 'category', 'quantity', 'unit', 'deadline', 'budget', 'specifications'];

// PATCH /api/rfqs/:id  (buyer, owner only) - edit content (before any quotes), or publish/close
const updateRFQ = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const contentChanged = CONTENT_FIELDS.some((f) => req.body[f] !== undefined);

  let deadlineDate;
  if (req.body.deadline !== undefined && req.body.deadline !== null) {
    const parsed = parseDeadline(req.body.deadline);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    deadlineDate = parsed.date;
  }
  let budget;
  if (req.body.budget !== undefined && req.body.budget !== null) {
    const parsed = parseAmount(req.body.budget, 'budget');
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    budget = parsed.value;
  }

  let category;
  if (req.body.category !== undefined && req.body.category !== null && req.body.category !== '') {
    const checked = checkCategory(req.body.category);
    if (checked.error) return res.status(400).json({ error: checked.error });
    category = checked.value;
  }
  const specs = parseSpecifications(req.body.specifications);
  if (specs.error) return res.status(400).json({ error: specs.error });

  const result = await prisma.$transaction(async (tx) => {
    // Lock the row so a concurrent quote submission or award can't slip between the checks and the update
    await tx.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${req.params.id} FOR UPDATE`;
    const existing = await tx.rFQ.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { quotes: true } } },
    });
    if (!existing) return { status: 404, error: 'RFQ not found' };
    if (existing.buyerCompanyId !== req.user.companyId) return { status: 403, error: 'Not your RFQ' };

    if (status !== undefined && status !== existing.status) {
      const allowed = BUYER_STATUS_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(status)) {
        return { status: 400, error: `Cannot change RFQ status from ${existing.status} to ${status}` };
      }
      if (status === 'PUBLISHED' && budget === undefined && existing.budget === null) {
        return { status: 400, error: BUDGET_REQUIRED };
      }
      if (status === 'PUBLISHED' && !validQuantity(req.body.quantity !== undefined ? req.body.quantity : existing.quantity)) {
        return { status: 400, error: QUANTITY_REQUIRED };
      }
      if (status === 'PUBLISHED' && !category) {
        if (!existing.category) return { status: 400, error: CATEGORY_REQUIRED };
        const stored = checkCategory(existing.category);
        if (stored.error) return { status: 400, error: stored.error };
        category = stored.value;
      }
    }

    // Suppliers pay to quote against the RFQ as it was published, so its content is frozen once quotes exist
    if (contentChanged) {
      if (!['DRAFT', 'PUBLISHED'].includes(existing.status)) {
        return { status: 400, error: `Cannot edit an RFQ in ${existing.status} status` };
      }
      if (existing._count.quotes > 0) {
        return { status: 409, error: 'Cannot edit an RFQ after quotes have been submitted' };
      }
      if (req.body.quantity !== undefined && (status || existing.status) === 'PUBLISHED' && !validQuantity(req.body.quantity)) {
        return { status: 400, error: QUANTITY_REQUIRED };
      }
    }

    const { title, description, quantity, unit } = req.body;
    const rfq = await tx.rFQ.update({
      where: { id: existing.id },
      data: {
        title, description, category, quantity, unit, budget,
        specifications: specs.value,
        deadline: deadlineDate,
        status,
      },
    });
    return { rfq, justPublished: status === 'PUBLISHED' && existing.status !== 'PUBLISHED' };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result.rfq);
  if (result.justPublished) notifyNewRfq('New RFQ in ' + result.rfq.category, result.rfq.title);
});

// POST /api/rfqs/:id/cancel  (buyer, owner only)
// Marks the RFQ CANCELLED (never deleted), rejects its open quotes, refunds every bid fee paid on it
// and notifies the affected suppliers — all in one transaction.
const cancelRFQ = asyncHandler(async (req, res) => {
  const rfqId = req.params.id;

  const result = await prisma.$transaction(async (tx) => {
    // Same lock as submitQuote/award: no new paid quote or award can land while we refund
    await tx.$queryRaw`SELECT id FROM "RFQ" WHERE id = ${rfqId} FOR UPDATE`;
    const rfq = await tx.rFQ.findUnique({ where: { id: rfqId } });
    if (!rfq) return { status: 404, error: 'RFQ not found' };
    if (rfq.buyerCompanyId !== req.user.companyId) return { status: 403, error: 'Not your RFQ' };
    if (!CANCELLABLE_STATUSES.includes(rfq.status)) {
      return { status: 400, error: `Cannot cancel an RFQ in ${rfq.status} status` };
    }

    return cancelRfqInTx(tx, rfq);
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

module.exports = { createRFQ, listRFQs, getRFQ, updateRFQ, cancelRFQ };