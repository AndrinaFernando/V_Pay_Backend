const crypto = require('crypto');

const {
  FieldValue,
  Timestamp,
} = require('firebase-admin/firestore');

function createInitialVirtualCardData(ownerId) {
  const lastFourDigits = crypto
    .randomInt(0, 10000)
    .toString()
    .padStart(4, '0');

  const expirationDate = new Date();
  expirationDate.setUTCFullYear(expirationDate.getUTCFullYear() + 3);

  return {
    ownerId,
    maskedNumber: `**** **** **** ${lastFourDigits}`,
    balance: 0,
    status: 'ACTIVE',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromDate(expirationDate),
  };
}

module.exports = {
  createInitialVirtualCardData,
};
