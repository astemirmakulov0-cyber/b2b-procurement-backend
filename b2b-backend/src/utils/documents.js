// Verification documents are uploaded as data: URLs (the UI reads the file with FileReader).
// Only PDFs and raster images are accepted: anything else stored in fileUrl (javascript:, SVG with
// script, arbitrary links) could run in the admin's browser when opened.

const DOC_TYPES = ['TRADE_LICENSE', 'CR_CERTIFICATE', 'OTHER'];
const MAX_DOC_BYTES = 2 * 1024 * 1024; // same limit as the upload form
const DATA_URL_RE = /^data:(application\/pdf|image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

// Returns { mime } for an acceptable document, { error } otherwise
function checkDocument(fileUrl) {
  if (typeof fileUrl !== 'string') return { error: 'fileUrl must be a PDF or image file' };
  const m = DATA_URL_RE.exec(fileUrl);
  if (!m) return { error: 'Only PDF, PNG, JPEG, WebP or GIF files are accepted' };
  const bytes = Math.floor((m[2].length * 3) / 4) - (m[2].endsWith('==') ? 2 : m[2].endsWith('=') ? 1 : 0);
  if (bytes > MAX_DOC_BYTES) return { error: 'File must be under 2MB' };
  return { mime: m[1] };
}

// Document fields safe to list (no file content)
const DOC_META = { id: true, docType: true, uploadedAt: true };

module.exports = { DOC_TYPES, checkDocument, DOC_META };
