// Files that arrive as data: URLs (the UI reads them with FileReader): verification documents and catalog
// photos. Checked here, then stored in the private bucket. Only PDFs and raster images are accepted: anything
// else (javascript:, links, SVG with script, HTML) could run in a viewer's browser when shown.
const { sniffType } = require('./upload');

const DOC_TYPES = ['TRADE_LICENSE', 'CR_CERTIFICATE', 'OTHER'];
const MAX_DOC_BYTES = 2 * 1024 * 1024; // same limit as the upload form
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // the UI sends photos resized to 1024 px JPEG, far below this
const DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;

const DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// GIF isn't accepted for order documents or bid attachments, but verification documents always allowed it
const isGif = (buf) => buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('latin1'));

// Decodes a data: URL and checks the real type (by content, not the declared one) and the size.
// Returns { buffer, contentType } or { error }.
function parseDataUrl(value, { types, maxBytes, label }) {
  if (typeof value !== 'string') return { error: `${label} must be ${describe(types)}` };
  const m = DATA_URL_RE.exec(value);
  if (!m || !types.includes(m[1])) return { error: `Only ${describe(types)} files are accepted` };
  // size from the base64 length first, so an oversized upload isn't decoded at all
  const bytes = Math.floor((m[2].length * 3) / 4) - (m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0);
  if (bytes > maxBytes) return { error: `${label} must be under ${maxBytes / 1024 / 1024}MB` };
  const buffer = Buffer.from(m[2], 'base64');
  const sniffed = sniffType(buffer) || (isGif(buffer) ? 'image/gif' : null);
  if (!sniffed || !types.includes(sniffed)) return { error: `The file content is not ${describe(types)}` };
  return { buffer, contentType: sniffed };
}

function describe(types) {
  const names = types.map((t) => ({ 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' }[t]));
  return names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
}

const checkDocument = (fileUrl) => parseDataUrl(fileUrl, { types: DOCUMENT_TYPES, maxBytes: MAX_DOC_BYTES, label: 'File' });
const checkCatalogImage = (imageUrl) => parseDataUrl(imageUrl, { types: IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES, label: 'Photo' });

// Document fields safe to list (no file content)
const DOC_META = { id: true, docType: true, uploadedAt: true };

module.exports = { DOC_TYPES, checkDocument, checkCatalogImage, DOC_META };
