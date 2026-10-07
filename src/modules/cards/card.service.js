const crypto = require('crypto');

const {
  FieldValue,
  Timestamp,
} = require('firebase-admin/firestore');
const { db } = require('../../config/firebase');

const CARD_LOOKUP_OUTCOMES = {
  FOUND: 'FOUND',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
};

function toIsoString(value) {
  if (!value) return null;

  const date =
    typeof value.toDate === 'function'
      ? value.toDate()
      : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function getCardForUser(uid) {
  const userSnapshot = await db.collection('users').doc(uid).get();

  if (!userSnapshot.exists) {
    return { outcome: CARD_LOOKUP_OUTCOMES.PROFILE_NOT_FOUND };
  }

  const role = userSnapshot.data().role;
  if (role !== 'CUSTOMER') {
    return { outcome: CARD_LOOKUP_OUTCOMES.ROLE_FORBIDDEN, role };
  }

  const cardSnapshot = await db.collection('cards').doc(uid).get();

  if (!cardSnapshot.exists) {
    return { outcome: CARD_LOOKUP_OUTCOMES.CARD_NOT_FOUND };
  }

  const card = cardSnapshot.data();
  const lastFourDigits = String(card.maskedNumber ?? '')
    .match(/(\d{4})$/)?.[1];

  return {
    outcome: CARD_LOOKUP_OUTCOMES.FOUND,
    card: {
      id: cardSnapshot.id,
      maskedNumber: lastFourDigits
        ? `•••• •••• •••• ${lastFourDigits}`
        : null,
      balance: card.balance,
      status: card.status,
      expiresAt: toIsoString(card.expiresAt),
      createdAt: toIsoString(card.createdAt),
    },
  };
}

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
  CARD_LOOKUP_OUTCOMES,
  createInitialVirtualCardData,
  getCardForUser,
};
