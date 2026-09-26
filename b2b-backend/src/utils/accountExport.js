// PDPL "Download my data": everything the company's own account can see about itself. Counterparty data is
// limited to what the UI already shows elsewhere (company id/name on a shared RFQ/LPO/order) — never a
// counterparty's contact details. Uploaded files are listed by name/type/date only, no download links.
async function exportMyData(prisma, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { company: true },
  });
  if (!user) return null;
  const company = user.company;

  const counterparty = { select: { id: true, name: true } };

  const [documents, catalogItems, rfqs, quotes, lposAsBuyer, lposAsSupplier, notifications] = company
    ? await Promise.all([
        prisma.companyDocument.findMany({
          where: { companyId: company.id },
          select: { docType: true, uploadedAt: true, contentType: true, sizeBytes: true },
        }),
        prisma.catalogItem.findMany({
          where: { supplierCompanyId: company.id },
          select: { name: true, description: true, price: true, unit: true, category: true, isActive: true, imageContentType: true, createdAt: true, updatedAt: true },
        }),
        prisma.rFQ.findMany({
          where: { buyerCompanyId: company.id },
          select: { id: true, title: true, description: true, specifications: true, category: true, quantity: true, unit: true, budget: true, deadline: true, status: true, createdAt: true, updatedAt: true },
        }),
        prisma.quote.findMany({
          where: { supplierCompanyId: company.id },
          select: {
            id: true, price: true, unitPrice: true, currency: true, deliveryTimeDays: true, notes: true, status: true, createdAt: true, updatedAt: true,
            rfq: { select: { id: true, title: true, buyerCompany: counterparty } },
            attachments: { where: { deletedAt: null }, select: { fileName: true, contentType: true, sizeBytes: true, createdAt: true } },
          },
        }),
        prisma.lPO.findMany({
          where: { buyerCompanyId: company.id },
          select: {
            id: true, terms: true, totalAmount: true, status: true, declineReason: true, createdAt: true, updatedAt: true,
            supplierCompany: counterparty, rfq: { select: { id: true, title: true } },
            order: {
              select: {
                id: true, status: true, receivedAt: true, createdAt: true,
                delivery: true,
                invoice: { select: { id: true, amount: true, status: true, dueDate: true, issuedAt: true, payments: { select: { amount: true, method: true, reference: true, status: true, paidAt: true, createdAt: true } } } },
                documents: { where: { deletedAt: null }, select: { kind: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, uploadedByCompany: counterparty } },
              },
            },
          },
        }),
        prisma.lPO.findMany({
          where: { supplierCompanyId: company.id },
          select: {
            id: true, terms: true, totalAmount: true, status: true, declineReason: true, createdAt: true, updatedAt: true,
            buyerCompany: counterparty, rfq: { select: { id: true, title: true } },
            order: {
              select: {
                id: true, status: true, receivedAt: true, createdAt: true,
                delivery: true,
                invoice: { select: { id: true, amount: true, status: true, dueDate: true, issuedAt: true, payments: { select: { amount: true, method: true, reference: true, status: true, paidAt: true, createdAt: true } } } },
                documents: { where: { deletedAt: null }, select: { kind: true, fileName: true, contentType: true, sizeBytes: true, createdAt: true, uploadedByCompany: counterparty } },
              },
            },
          },
        }),
        prisma.notification.findMany({
          where: { companyId: company.id },
          select: { type: true, title: true, body: true, relatedOrderId: true, read: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
      ])
    : [[], [], [], [], [], [], []];

  return {
    exportedAt: new Date().toISOString(),
    profile: { id: user.id, email: user.email, role: user.role, emailVerified: user.emailVerified, createdAt: user.createdAt },
    company: company && {
      id: company.id, name: company.name, type: company.type, registrationNumber: company.registrationNumber,
      country: company.country, address: company.address, phone: company.phone,
      verificationStatus: company.verificationStatus, consentAt: company.consentAt,
      emailNewRfq: company.emailNewRfq, emailOtherNotifications: company.emailOtherNotifications,
      createdAt: company.createdAt,
    },
    uploadedFiles: { verificationDocuments: documents },
    catalogItems,
    rfqsPosted: rfqs,
    quotesSubmitted: quotes,
    purchaseOrders: { asBuyer: lposAsBuyer, asSupplier: lposAsSupplier },
    notifications,
  };
}

module.exports = { exportMyData };
