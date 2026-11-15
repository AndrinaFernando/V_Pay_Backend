const PAYMENT_INTENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
});

const PAYMENT_INTENT_OUTCOMES = Object.freeze({
  CREATED: 'CREATED',
  FOUND: 'FOUND',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
});

function toDate(value) {
  if (value instanceof Date) return value;
  if (value && typeof value.toDate === 'function') return value.toDate();
  return null;
}

function toIsoString(value) {
  const date = toDate(value);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function toPublicPaymentIntent(paymentReference, data) {
  const paymentIntent = {
    paymentReference,
    merchantName: data.merchantName,
    amountMinor: data.amountMinor,
    currency: data.currency,
    status: data.status,
    createdAt: toIsoString(data.createdAt),
    expiresAt: toIsoString(data.expiresAt),
  };

  if (data.description) paymentIntent.description = data.description;
  const paidAt = toIsoString(data.paidAt);
  if (paidAt) paymentIntent.paidAt = paidAt;

  return paymentIntent;
}

function createPaymentService({ db, clock = () => new Date() }) {
  if (!db) throw new TypeError('Firestore database is required');

  async function getMerchant(uid) {
    const snapshot = await db.collection('users').doc(uid).get();
    if (!snapshot.exists) {
      return { outcome: PAYMENT_INTENT_OUTCOMES.PROFILE_NOT_FOUND };
    }

    const merchant = snapshot.data();
    if (merchant.role !== 'MERCHANT' || merchant.status !== 'ACTIVE') {
      return {
        outcome: PAYMENT_INTENT_OUTCOMES.ROLE_FORBIDDEN,
        role: merchant.role,
      };
    }

    return { merchant };
  }

  async function createPaymentIntent({ uid, amountMinor, currency, description, expiresInSeconds }) {
    const merchantResult = await getMerchant(uid);
    if (merchantResult.outcome) return merchantResult;

    const merchant = merchantResult.merchant;
    const createdAt = clock();
    const expiresAt = new Date(
      createdAt.getTime() + expiresInSeconds * 1000
    );
    const intentRef = db.collection('paymentIntents').doc();
    const paymentIntent = {
      merchantUid: uid,
      merchantName: merchant.businessName,
      amountMinor,
      currency,
      status: PAYMENT_INTENT_STATUS.PENDING,
      createdAt,
      expiresAt,
      ...(description && { description }),
    };

    await db.runTransaction(async (transaction) => {
      transaction.create(intentRef, paymentIntent);
    });

    return {
      outcome: PAYMENT_INTENT_OUTCOMES.CREATED,
      paymentIntent: toPublicPaymentIntent(intentRef.id, paymentIntent),
    };
  }

  async function getPaymentIntent({ uid, paymentReference }) {
    const merchantResult = await getMerchant(uid);
    if (merchantResult.outcome) return merchantResult;

    if (
      typeof paymentReference !== 'string' ||
      paymentReference.length === 0 ||
      paymentReference.length > 128 ||
      paymentReference.includes('/')
    ) {
      return { outcome: PAYMENT_INTENT_OUTCOMES.NOT_FOUND };
    }

    const intentRef = db.collection('paymentIntents').doc(paymentReference);

    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(intentRef);
      if (!snapshot.exists) {
        return { outcome: PAYMENT_INTENT_OUTCOMES.NOT_FOUND };
      }

      const data = snapshot.data();
      if (data.merchantUid !== uid) {
        return { outcome: PAYMENT_INTENT_OUTCOMES.NOT_FOUND };
      }

      let status = data.status;
      if (status === PAYMENT_INTENT_STATUS.PENDING) {
        const expiresAt = toDate(data.expiresAt);
        if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
          throw new Error('Payment intent has invalid expiry data');
        }

        if (expiresAt.getTime() <= clock().getTime()) {
          status = PAYMENT_INTENT_STATUS.EXPIRED;
          transaction.update(intentRef, { status });
        }
      }

      return {
        outcome: PAYMENT_INTENT_OUTCOMES.FOUND,
        paymentIntent: toPublicPaymentIntent(paymentReference, {
          ...data,
          status,
        }),
      };
    });
  }

  return { createPaymentIntent, getPaymentIntent };
}

function getDefaultService() {
  const { db } = require('../../config/firebase');
  return createPaymentService({ db });
}

async function createPaymentIntent(input) {
  return getDefaultService().createPaymentIntent(input);
}

async function getPaymentIntent(input) {
  return getDefaultService().getPaymentIntent(input);
}

module.exports = {
  PAYMENT_INTENT_OUTCOMES,
  PAYMENT_INTENT_STATUS,
  createPaymentIntent,
  createPaymentService,
  getPaymentIntent,
};
