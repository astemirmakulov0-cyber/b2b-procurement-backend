const { Prisma } = require('@prisma/client');

// All money columns are Decimal(12, 3): BHD has 1000 fils, so amounts carry up to 3 decimals.
const MONEY_DECIMALS = 3;
const MONEY_MAX = new Prisma.Decimal('999999999.999');

// Validates a positive money amount sent as a JSON number. Returns { value: Decimal } or { error }.
// Rejects extra decimals instead of letting Postgres round them silently.
function parseAmount(raw, field = 'amount') {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return { error: `${field} must be a positive number` };
  const value = new Prisma.Decimal(raw);
  if (value.decimalPlaces() > MONEY_DECIMALS) return { error: `${field} can have at most ${MONEY_DECIMALS} decimal places` };
  if (value.gt(MONEY_MAX)) return { error: `${field} is too large` };
  return { value };
}

// Fixed 3-decimal string for messages and API fields, e.g. "25.000"
const formatAmount = (d) => new Prisma.Decimal(d).toFixed(MONEY_DECIMALS);

module.exports = { MONEY_DECIMALS, parseAmount, formatAmount };
