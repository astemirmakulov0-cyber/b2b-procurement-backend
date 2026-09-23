module.exports = function asyncHandler(fn) {
  return (req, res, next) => {
    // Deferred from the JSON parser in index.js so auth/role checks answer first
    if (req.bodyParseError) return res.status(400).json({ error: 'Invalid JSON body' });
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
};
