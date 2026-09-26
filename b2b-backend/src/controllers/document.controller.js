// Order documents: delivery notes, invoices and other files, visible only to the order's parties and admins.
const Sentry = require('@sentry/node');
const prisma = require('../config/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { notify } = require('../utils/notify');
const storage = require('../utils/storage');
const { readSingleFile, sniffType, storedFileName } = require('../utils/upload');

// Who may upload each kind: the supplier issues delivery notes and invoices; either party adds other files.
// QUOTE_ATTACHMENT documents aren't uploaded here: they are the winning bid's attachments, added on LPO acceptance.
const KIND_UPLOADERS = { DELIVERY_NOTE: ['supplier'], INVOICE: ['supplier'], OTHER: ['buyer', 'supplier'] };
const KIND_LABELS = { DELIVERY_NOTE: 'delivery note', INVOICE: 'invoice', OTHER: 'document', QUOTE_ATTACHMENT: 'bid attachment' };
const MAX_DOCUMENTS_PER_ORDER = 50;
// documents can still be removed while the order is open; a finished order's records stay as they are
const CLOSED_ORDER_STATUSES = ['COMPLETED', 'CANCELLED'];

// what the API shows about a document (never the storage key)
const DOC_SELECT = {
  id: true, orderId: true, kind: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true,
  uploadedByCompanyId: true, uploadedByCompany: { select: { id: true, name: true, isActive: true } },
};

// The caller's role in the order: 'buyer' | 'supplier' | 'admin' (admins read only), or an error
async function orderAccess(orderId, user) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lpo: true } });
  if (!order) return { error: [404, 'Order not found'] };
  if (user.companyId && order.lpo.buyerCompanyId === user.companyId) return { order, role: 'buyer' };
  if (user.companyId && order.lpo.supplierCompanyId === user.companyId) return { order, role: 'supplier' };
  if (user.role === 'ADMIN') return { order, role: 'admin' };
  return { error: [403, 'Forbidden'] };
}

// GET /api/orders/:id/documents  (parties, admin)
const listOrderDocuments = asyncHandler(async (req, res) => {
  const { order, error } = await orderAccess(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const docs = await prisma.orderDocument.findMany({
    where: { orderId: order.id, deletedAt: null }, select: DOC_SELECT, orderBy: { createdAt: 'asc' },
  });
  res.json(docs);
});

// POST /api/orders/:id/documents  (parties)  multipart/form-data: kind, file
// One file per request, at most 10 MB, PDF / JPEG / PNG / WebP by content.
const uploadOrderDocument = asyncHandler(async (req, res) => {
  if (!storage.isConfigured()) return res.status(503).json({ error: 'File storage is not configured' });
  const { order, role, error } = await orderAccess(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });
  if (role === 'admin') return res.status(403).json({ error: 'Only the buyer or the supplier can add documents' });
  if (order.status === 'CANCELLED') return res.status(400).json({ error: 'Cannot add documents to a cancelled order' });
  if (await prisma.orderDocument.count({ where: { orderId: order.id, deletedAt: null } }) >= MAX_DOCUMENTS_PER_ORDER) {
    return res.status(400).json({ error: `An order can have at most ${MAX_DOCUMENTS_PER_ORDER} documents` });
  }

  const { fields, file } = await readSingleFile(req);
  const kind = fields.kind;
  if (!KIND_UPLOADERS[kind]) return res.status(400).json({ error: 'kind must be one of ' + Object.keys(KIND_UPLOADERS).join(', ') });
  if (!KIND_UPLOADERS[kind].includes(role)) return res.status(403).json({ error: `Only the supplier can add a ${KIND_LABELS[kind]}` });
  if (!file || file.buffer.length === 0) return res.status(400).json({ error: 'A file is required' });
  const contentType = sniffType(file.buffer);
  if (!contentType) return res.status(415).json({ error: 'Only PDF, JPEG, PNG or WebP files are accepted' });

  const fileName = storedFileName(file.fileName, contentType);

  const storageKey = storage.newKey(`orders/${order.id}`);
  try {
    await storage.putObject(storageKey, file.buffer, contentType);
  } catch (err) {
    Sentry.captureException(err, { tags: { area: 'storage' }, extra: { orderId: order.id, storageKey } });
    console.error('storage put failed:', err.message);
    return res.status(502).json({ error: 'Could not store the file, please try again' });
  }
  // the row is written after the object, so a listed document always has its file
  const doc = await prisma.orderDocument.create({
    data: { orderId: order.id, kind, fileName, contentType, sizeBytes: file.buffer.length, storageKey, uploadedByCompanyId: req.user.companyId },
    select: DOC_SELECT,
  });
  res.status(201).json(doc);

  const other = role === 'buyer' ? order.lpo.supplierCompanyId : order.lpo.buyerCompanyId;
  notify(other, 'DOCUMENT_ADDED', 'New ' + KIND_LABELS[kind] + ' on your order',
    doc.uploadedByCompany.name + ' added "' + fileName + '".', order.id);
});

// Loads a live document and the caller's role in its order
async function documentAccess(docId, user) {
  const doc = await prisma.orderDocument.findFirst({ where: { id: docId, deletedAt: null } });
  if (!doc) return { error: [404, 'Document not found'] };
  const access = await orderAccess(doc.orderId, user);
  if (access.error) return { error: access.error[0] === 404 ? [404, 'Document not found'] : access.error };
  return { doc, ...access };
}

// GET /api/documents/:id/download  (parties, admin) -> { url, expiresIn, fileName }
// The URL is presigned for 120 seconds and downloads the file as an attachment.
const downloadDocument = asyncHandler(async (req, res) => {
  if (!storage.isConfigured()) return res.status(503).json({ error: 'File storage is not configured' });
  const { doc, error } = await documentAccess(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });
  const url = await storage.presignDownload(doc.storageKey, doc.fileName, doc.contentType);
  res.set('Cache-Control', 'no-store').json({ url, expiresIn: storage.DOWNLOAD_URL_TTL_SECONDS, fileName: doc.fileName });
});

// DELETE /api/documents/:id  (the uploading party, while the order is open) - hides the document; the file is kept
const deleteDocument = asyncHandler(async (req, res) => {
  const { doc, order, error } = await documentAccess(req.params.id, req.user);
  if (error) return res.status(error[0]).json({ error: error[1] });
  if (doc.uploadedByCompanyId !== req.user.companyId) return res.status(403).json({ error: 'Only the company that added a document can remove it' });
  if (doc.kind === 'QUOTE_ATTACHMENT') return res.status(400).json({ error: 'Bid attachments are part of the accepted quote and cannot be removed' });
  if (CLOSED_ORDER_STATUSES.includes(order.status)) return res.status(400).json({ error: `Documents of a ${order.status} order cannot be removed` });
  const { count } = await prisma.orderDocument.updateMany({ where: { id: doc.id, deletedAt: null }, data: { deletedAt: new Date() } });
  if (count === 0) return res.status(404).json({ error: 'Document not found' });
  res.json({ ok: true });
});

module.exports = { listOrderDocuments, uploadOrderDocument, downloadDocument, deleteDocument };
