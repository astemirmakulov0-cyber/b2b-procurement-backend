const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { parseAmount } = require('../utils/money');
const Sentry = require('@sentry/node');
const storage = require('../utils/storage');
const { checkCatalogImage } = require('../utils/documents');

// An item as the API shows it: the photo as a presigned URL in imageUrl (stable within the hour, valid 2 h),
// never the bucket key. Items not yet moved to the bucket keep their legacy data: URL until it is cleared.
async function presentItem(item) {
  const { imageKey, imageContentType, ...rest } = item;
  if (!imageKey) return rest;
  return { ...rest, imageUrl: storage.isConfigured() ? await storage.presignStable(imageKey, imageContentType) : null };
}

// POST /api/catalog  (supplier)  body: { name, price, description?, unit?, category?, imageUrl?: data: URL }
// The photo must be a JPEG, PNG or WebP data: URL under 2MB (checked by content); it is stored in the bucket.
const createItem = asyncHandler(async (req, res) => {
  const { name, description, unit, category, imageUrl } = req.body;
  if (!name || req.body.price === undefined) return res.status(400).json({ error: 'name and price required' });
  const price = parseAmount(req.body.price, 'price');
  if (price.error) return res.status(400).json({ error: price.error });

  let image = {};
  if (imageUrl !== undefined && imageUrl !== null && imageUrl !== '') {
    const checked = checkCatalogImage(imageUrl);
    if (checked.error) return res.status(400).json({ error: checked.error });
    if (!storage.isConfigured()) return res.status(503).json({ error: 'File storage is not configured' });
    const imageKey = storage.newKey('catalog/' + req.user.companyId);
    try {
      await storage.putObject(imageKey, checked.buffer, checked.contentType);
    } catch (err) {
      Sentry.captureException(err, { tags: { area: 'storage' }, extra: { companyId: req.user.companyId, imageKey } });
      console.error('storage put failed:', err.message);
      return res.status(502).json({ error: 'Could not store the photo, please try again' });
    }
    image = { imageKey, imageContentType: checked.contentType };
  }

  const item = await prisma.catalogItem.create({
    data: { supplierCompanyId: req.user.companyId, name, description, price: price.value, unit, category, ...image },
  });
  res.status(201).json(await presentItem(item));
});

// GET /api/catalog  - public/browsable, optional filters
const listItems = asyncHandler(async (req, res) => {
  const { category, supplierCompanyId } = req.query;
  const items = await prisma.catalogItem.findMany({
    where: {
      isActive: true,
      supplierCompany: { isActive: true }, // hide items of deactivated suppliers
      category: category || undefined,
      supplierCompanyId: supplierCompanyId || undefined,
    },
    include: { supplierCompany: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(await Promise.all(items.map(presentItem)));
});

// PATCH /api/catalog/:id  (owner supplier)
const updateItem = asyncHandler(async (req, res) => {
  const existing = await prisma.catalogItem.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  if (existing.supplierCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

  const { name, description, unit, category, isActive } = req.body;
  let price;
  if (req.body.price !== undefined) {
    const parsed = parseAmount(req.body.price, 'price');
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    price = parsed.value;
  }
  const item = await prisma.catalogItem.update({
    where: { id: req.params.id },
    data: { name, description, price, unit, category, isActive },
  });
  res.json(await presentItem(item));
});

// DELETE /api/catalog/:id  (owner supplier)
const deleteItem = asyncHandler(async (req, res) => {
  const existing = await prisma.catalogItem.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  if (existing.supplierCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

  await prisma.catalogItem.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

module.exports = { createItem, listItems, updateItem, deleteItem };
