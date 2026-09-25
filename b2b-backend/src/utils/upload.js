// Reading one uploaded file from a multipart/form-data request, and checking what it really is.
const busboy = require('busboy');

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const fail = (status, message) => Object.assign(new Error(message), { status });

// Reads a multipart body with exactly one file (field "file") and a few short text fields into memory
// (files are small; buffering lets us check the content and the exact size before storing anything).
// Resolves { fields, file: { buffer, fileName } | null }; rejects with a 4xx error.
function readSingleFile(req, maxBytes = MAX_FILE_BYTES) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      // browsers send the file name as raw UTF-8 (busboy's default is latin1, which garbles non-ASCII names)
      bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fileSize: maxBytes, fields: 10, fieldSize: 1024, parts: 12 } });
    } catch (e) {
      return reject(fail(400, 'Expected a multipart/form-data upload'));
    }
    const fields = {};
    let file = null;
    let error = null;
    const setError = (e) => { if (!error) error = e; };

    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (name, stream, info) => {
      if (name !== 'file') { stream.resume(); return setError(fail(400, 'The file must be sent in the "file" field')); }
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => { size += c.length; chunks.push(c); });
      stream.on('limit', () => setError(fail(413, `File must be at most ${maxBytes / 1024 / 1024} MB`)));
      stream.on('end', () => { if (!error) file = { buffer: Buffer.concat(chunks, size), fileName: info.filename || '' }; });
    });
    bb.on('filesLimit', () => setError(fail(400, 'Upload one file at a time')));
    bb.on('fieldsLimit', () => setError(fail(400, 'Too many form fields')));
    bb.on('partsLimit', () => setError(fail(400, 'Too many form parts')));
    bb.on('error', () => setError(fail(400, 'Malformed upload')));
    bb.on('close', () => (error ? reject(error) : resolve({ fields, file })));
    req.pipe(bb);
  });
}

// The real type from the first bytes (the declared type and the extension are not trusted). Only formats
// that browsers never execute: PDF and raster images — no SVG, HTML or office files.
function sniffType(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// A display/download name: no path, no control characters, at most 200 characters
function cleanFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, '').trim();
  return (base || 'document').slice(0, 200);
}

const EXTENSIONS = { 'application/pdf': ['.pdf'], 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'] };

// The stored name: the cleaned original, with an extension that matches the real content
function storedFileName(name, contentType) {
  const fileName = cleanFileName(name);
  if (EXTENSIONS[contentType].some((ext) => fileName.toLowerCase().endsWith(ext))) return fileName;
  return fileName.slice(0, 195) + EXTENSIONS[contentType][0];
}

module.exports = { MAX_FILE_BYTES, readSingleFile, sniffType, cleanFileName, storedFileName };
