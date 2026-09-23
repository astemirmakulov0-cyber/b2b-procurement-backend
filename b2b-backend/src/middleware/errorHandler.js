// Catches errors thrown/passed from asyncHandler-wrapped controllers
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  // 4xx are expected client errors: one line is enough; keep full stacks for real failures
  if (status >= 500) console.error(err);
  else console.warn(`${status} ${req.method} ${req.originalUrl}: ${err.message}`);
  const message = status >= 500 ? 'Internal server error' : err.message;
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
