const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');

// POST /api/catalog  (supplier)
const createItem = asyncHandler(async (req, res) => {
  const { name, description, price, unit, category, imageUrl } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'name and price required' });

  const item = await prisma.catalogItem.create({
    data: { supplierCompanyId: req.user.companyId, name, description, price, unit, category, imageUrl },
  });
  res.status(201).json(item);
});

// GET /api/catalog  - public/browsable, optional filters
const listItems = asyncHandler(async (req, res) => {
  const { category, supplierCompanyId } = req.query;
  const items = await prisma.catalogItem.findMany({
    where: {
      isActive: true,
      category: category || undefined,
      supplierCompanyId: supplierCompanyId || undefined,
    },
    include: { supplierCompany: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(items);
});

// PATCH /api/catalog/:id  (owner supplier)
const updateItem = asyncHandler(async (req, res) => {
  const existing = await prisma.catalogItem.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  if (existing.supplierCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Forbidden' });

  const { name, description, price, unit, category, isActive } = req.body;
  const item = await prisma.catalogItem.update({
    where: { id: req.params.id },
    data: { name, description, price, unit, category, isActive },
  });
  res.json(item);
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
