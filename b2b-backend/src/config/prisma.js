const { PrismaClient } = require('@prisma/client');

// Defaults for every interactive prisma.$transaction(async (tx) => ...): the app and the database are in
// different regions, so a transaction with several queries can exceed Prisma's 5s default.
// maxWait = how long to wait for a pooled connection, timeout = how long the transaction may run.
const prisma = new PrismaClient({
  transactionOptions: { maxWait: 10000, timeout: 15000 },
});

module.exports = prisma;
