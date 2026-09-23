const { Prisma } = require('@prisma/client');

// Turns Prisma errors caused by the request (bad ids, duplicates, invalid enum values...) into 4xx
// with a safe message. Registered before Sentry's handler so these aren't reported as server errors.
function prismaErrors(err, req, res, next) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const map = {
      P2002: [409, 'A record with these values already exists'],
      P2003: [409, 'This operation conflicts with related records'],
      P2025: [404, 'Record not found'],
      P2023: [400, 'Invalid identifier'],
      P2000: [400, 'A value is too long'],
    };
    const hit = map[err.code];
    if (hit) return next(Object.assign(new Error(hit[1]), { status: hit[0], cause: err }));
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    // e.g. an unknown enum value or a string where a number is expected
    return next(Object.assign(new Error('Invalid request data'), { status: 400, cause: err }));
  }
  next(err);
}

module.exports = prismaErrors;
