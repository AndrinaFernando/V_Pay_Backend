const {
  PAYMENT_AMOUNT_VALIDATION_OUTCOMES,
  validatePaymentAmount,
} = require('./payment.amount.validation');
const {
  getMaximumPaymentAmountMinor,
} = require('./payment.limit.provider');
const {
  MIN_RETAINED_BALANCE_MINOR,
  PAYMENT_BALANCE_VALIDATION_OUTCOMES,
  validatePaymentBalance,
} = require('./payment.balance.validation');

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
  LISTED: 'LISTED',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
});

const PAYMENT_EXECUTION_OUTCOMES = Object.freeze({
  SUCCEEDED: 'SUCCEEDED',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  PAYMENT_EXPIRED: 'PAYMENT_EXPIRED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_ALREADY_PAID: 'PAYMENT_ALREADY_PAID',
  PAYMENT_BELOW_MINIMUM: 'PAYMENT_BELOW_MINIMUM',
  PAYMENT_LIMIT_EXCEEDED: 'PAYMENT_LIMIT_EXCEEDED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  MINIMUM_BALANCE_REQUIRED: 'MINIMUM_BALANCE_REQUIRED',
  CARD_FROZEN: 'CARD_FROZEN',
  CARD_EXPIRED: 'CARD_EXPIRED',
  ACCOUNT_NOT_READY: 'ACCOUNT_NOT_READY',
  MERCHANT_UNAVAILABLE: 'MERCHANT_UNAVAILABLE',
  INVALID_BALANCE_SCHEMA: 'INVALID_BALANCE_SCHEMA',
  PAYMENT_CONFLICT: 'PAYMENT_CONFLICT',
  PAYMENT_UNAVAILABLE: 'PAYMENT_UNAVAILABLE',
});

const PAYMENT_CURRENCY = 'LKR';
const QR_TRANSACTION_PREFIX = 'qr-payment--';

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

function isQrPaymentExecutionEnabled() {
  return (
    process.env.VPAY_QR_PAYMENT_EXECUTION_ENABLED
      ?.trim()
      .toLowerCase() === 'true'
  );
}

function buildQrTransactionId(paymentReference) {
  return `${QR_TRANSACTION_PREFIX}${paymentReference}`;
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function toPaymentConfirmation(
  paymentReference,
  transactionId,
  paymentIntent,
) {
  return {
    transactionId,
    paymentReference,
    merchantName: paymentIntent.merchantName,
    amountMinor: paymentIntent.amountMinor,
    currency: paymentIntent.currency,
    status: PAYMENT_INTENT_STATUS.SUCCESS,
    paidAt: toIsoString(paymentIntent.paidAt),
  };
}

function toMinimalPaymentStatus(paymentReference, status) {
  return { paymentReference, status };
}

function isConsistentQrTransaction(
  transactionRecord,
  paymentIntent,
  paymentReference,
  customerUid,
) {
  const createdAt = toDate(transactionRecord.createdAt);
  const paidAt = toDate(paymentIntent.paidAt);

  return (
    transactionRecord.type === 'QR_PAYMENT' &&
    transactionRecord.paymentReference === paymentReference &&
    transactionRecord.customerUid === customerUid &&
    transactionRecord.merchantUid === paymentIntent.merchantUid &&
    transactionRecord.amountMinor === paymentIntent.amountMinor &&
    transactionRecord.currency === paymentIntent.currency &&
    transactionRecord.status === PAYMENT_INTENT_STATUS.SUCCESS &&
    createdAt !== null &&
    paidAt !== null &&
    !Number.isNaN(createdAt.getTime()) &&
    !Number.isNaN(paidAt.getTime()) &&
    createdAt.getTime() === paidAt.getTime()
  );
}

function createPaymentService({
  db,
  clock = () => new Date(),
  executionEnabled = isQrPaymentExecutionEnabled,
  spendingLimitProvider = getMaximumPaymentAmountMinor,
}) {
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

  async function getCustomer(uid) {
    const snapshot = await db.collection('users').doc(uid).get();
    if (!snapshot.exists) {
      return { outcome: PAYMENT_INTENT_OUTCOMES.PROFILE_NOT_FOUND };
    }

    const customer = snapshot.data();
    if (customer.role !== 'CUSTOMER' || customer.status !== 'ACTIVE') {
      return {
        outcome: PAYMENT_INTENT_OUTCOMES.ROLE_FORBIDDEN,
        role: customer.role,
      };
    }

    return { customer };
  }

  function isValidPaymentReference(paymentReference) {
    return (
      typeof paymentReference === 'string' &&
      paymentReference.length > 0 &&
      paymentReference.length <= 128 &&
      !paymentReference.includes('/')
    );
  }

  async function findPaymentIntent({ paymentReference, merchantUid }) {
    if (!isValidPaymentReference(paymentReference)) {
      return { outcome: PAYMENT_INTENT_OUTCOMES.NOT_FOUND };
    }

    const intentRef = db.collection('paymentIntents').doc(paymentReference);

    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(intentRef);
      if (!snapshot.exists) {
        return { outcome: PAYMENT_INTENT_OUTCOMES.NOT_FOUND };
      }

      const data = snapshot.data();
      if (merchantUid !== undefined && data.merchantUid !== merchantUid) {
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

  async function getPaymentIntent({ uid, paymentReference }) {
    const merchantResult = await getMerchant(uid);
    if (merchantResult.outcome) return merchantResult;

    return findPaymentIntent({ paymentReference, merchantUid: uid });
  }

  async function listPaymentIntents({ uid, limit = 20 }) {
    const merchantResult = await getMerchant(uid);
    if (merchantResult.outcome) return merchantResult;

    const snapshot = await db
      .collection('paymentIntents')
      .where('merchantUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const paymentIntents = await Promise.all(
      snapshot.docs.map(async (document) =>
        db.runTransaction(async (transaction) => {
          const current = await transaction.get(document.ref);
          if (!current.exists) return null;

          const data = current.data();
          if (data.merchantUid !== uid) return null;

          let status = data.status;
          if (status === PAYMENT_INTENT_STATUS.PENDING) {
            const expiresAt = toDate(data.expiresAt);
            if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
              throw new Error('Payment intent has invalid expiry data');
            }
            if (expiresAt.getTime() <= clock().getTime()) {
              status = PAYMENT_INTENT_STATUS.EXPIRED;
              transaction.update(document.ref, { status });
            }
          }

          return toPublicPaymentIntent(document.id, { ...data, status });
        }),
      ),
    );

    return {
      outcome: PAYMENT_INTENT_OUTCOMES.LISTED,
      paymentIntents: paymentIntents.filter(Boolean),
    };
  }

  async function previewPaymentIntent({ uid, paymentReference }) {
    const customerResult = await getCustomer(uid);
    if (customerResult.outcome) return customerResult;

    return findPaymentIntent({ paymentReference });
  }

  async function confirmPaymentIntent({ uid, paymentReference }) {
    if (!executionEnabled()) {
      return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE };
    }

    if (!isValidPaymentReference(paymentReference)) {
      return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND };
    }

    const customerRef = db.collection('users').doc(uid);
    const cardRef = db.collection('cards').doc(uid);
    const intentRef = db.collection('paymentIntents').doc(paymentReference);
    const transactionId = buildQrTransactionId(paymentReference);
    const paymentTransactionRef = db
      .collection('transactions')
      .doc(transactionId);

    return db.runTransaction(async (transaction) => {
      const customerSnapshot = await transaction.get(customerRef);
      if (!customerSnapshot.exists) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY };
      }

      const customer = customerSnapshot.data();
      if (customer.role !== 'CUSTOMER' || customer.status !== 'ACTIVE') {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY };
      }

      const intentSnapshot = await transaction.get(intentRef);
      if (!intentSnapshot.exists) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND };
      }

      const paymentIntent = intentSnapshot.data();
      const paymentTransactionSnapshot = await transaction.get(
        paymentTransactionRef,
      );

      if (paymentIntent.status === PAYMENT_INTENT_STATUS.SUCCESS) {
        if (paymentIntent.customerUid !== uid) {
          return {
            outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_ALREADY_PAID,
          };
        }

        if (
          !paymentTransactionSnapshot.exists ||
          !isConsistentQrTransaction(
            paymentTransactionSnapshot.data(),
            paymentIntent,
            paymentReference,
            uid,
          )
        ) {
          return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT };
        }

        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
          idempotent: true,
          payment: toPaymentConfirmation(
            paymentReference,
            transactionId,
            paymentIntent,
          ),
        };
      }

      if (paymentTransactionSnapshot.exists) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT };
      }

      if (paymentIntent.status === PAYMENT_INTENT_STATUS.EXPIRED) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_EXPIRED };
      }

      if (paymentIntent.status === PAYMENT_INTENT_STATUS.PROCESSING) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT };
      }

      if (paymentIntent.status === PAYMENT_INTENT_STATUS.FAILED) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_FAILED };
      }

      if (paymentIntent.status !== PAYMENT_INTENT_STATUS.PENDING) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE };
      }

      const expiresAt = toDate(paymentIntent.expiresAt);
      const paidAt = clock();
      if (
        !expiresAt ||
        Number.isNaN(expiresAt.getTime()) ||
        !(paidAt instanceof Date) ||
        Number.isNaN(paidAt.getTime())
      ) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE };
      }

      if (expiresAt.getTime() <= paidAt.getTime()) {
        transaction.update(intentRef, {
          status: PAYMENT_INTENT_STATUS.EXPIRED,
        });
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_EXPIRED };
      }

      if (
        paymentIntent.currency !== PAYMENT_CURRENCY ||
        typeof paymentIntent.merchantUid !== 'string' ||
        paymentIntent.merchantUid.length === 0
      ) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE };
      }

      const maxLimitMinor = await spendingLimitProvider({
        customerUid: uid,
        customerProfile: customer,
      });
      const amountValidation = validatePaymentAmount(
        paymentIntent.amountMinor,
        maxLimitMinor,
      );
      if (
        amountValidation.outcome ===
          PAYMENT_AMOUNT_VALIDATION_OUTCOMES.PAYMENT_BELOW_MINIMUM ||
        amountValidation.outcome ===
          PAYMENT_AMOUNT_VALIDATION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED
      ) {
        return { outcome: amountValidation.outcome };
      }
      if (
        amountValidation.outcome !==
        PAYMENT_AMOUNT_VALIDATION_OUTCOMES.VALID
      ) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE };
      }

      const merchantRef = db
        .collection('users')
        .doc(paymentIntent.merchantUid);
      const merchantAccountRef = db
        .collection('merchantAccounts')
        .doc(paymentIntent.merchantUid);

      const cardSnapshot = await transaction.get(cardRef);
      const merchantSnapshot = await transaction.get(merchantRef);
      const merchantAccountSnapshot = await transaction.get(
        merchantAccountRef,
      );

      if (!cardSnapshot.exists) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY };
      }

      const card = cardSnapshot.data();
      if (card.ownerId !== uid) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY };
      }

      if (card.status === 'FROZEN') {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.CARD_FROZEN };
      }

      if (card.status !== 'ACTIVE' || card.currency !== PAYMENT_CURRENCY) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY };
      }

      const cardExpiresAt = toDate(card.expiresAt);
      if (!cardExpiresAt || Number.isNaN(cardExpiresAt.getTime())) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY };
      }

      if (cardExpiresAt.getTime() <= paidAt.getTime()) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.CARD_EXPIRED };
      }

      if (
        Object.prototype.hasOwnProperty.call(card, 'balance') ||
        !isNonnegativeSafeInteger(card.balanceMinor)
      ) {
        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.INVALID_BALANCE_SCHEMA,
        };
      }

      if (!merchantSnapshot.exists) {
        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.MERCHANT_UNAVAILABLE,
        };
      }

      const merchant = merchantSnapshot.data();
      if (merchant.role !== 'MERCHANT' || merchant.status !== 'ACTIVE') {
        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.MERCHANT_UNAVAILABLE,
        };
      }

      if (!merchantAccountSnapshot.exists) {
        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.MERCHANT_UNAVAILABLE,
        };
      }

      const merchantAccount = merchantAccountSnapshot.data();
      if (
        merchantAccount.status !== 'ACTIVE' ||
        merchantAccount.currency !== PAYMENT_CURRENCY
      ) {
        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.MERCHANT_UNAVAILABLE,
        };
      }

      if (!isNonnegativeSafeInteger(merchantAccount.balanceMinor)) {
        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.INVALID_BALANCE_SCHEMA,
        };
      }

      const balanceValidation = validatePaymentBalance(
        card.balanceMinor,
        paymentIntent.amountMinor,
        MIN_RETAINED_BALANCE_MINOR,
      );
      if (
        balanceValidation.outcome ===
        PAYMENT_BALANCE_VALIDATION_OUTCOMES.INSUFFICIENT_BALANCE
      ) {
        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.INSUFFICIENT_BALANCE,
        };
      }
      if (
        balanceValidation.outcome ===
        PAYMENT_BALANCE_VALIDATION_OUTCOMES.MINIMUM_BALANCE_REQUIRED
      ) {
        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED,
        };
      }
      if (
        balanceValidation.outcome !==
        PAYMENT_BALANCE_VALIDATION_OUTCOMES.VALID
      ) {
        return {
          outcome: PAYMENT_EXECUTION_OUTCOMES.INVALID_BALANCE_SCHEMA,
        };
      }

      if (
        merchantAccount.balanceMinor >
        Number.MAX_SAFE_INTEGER - paymentIntent.amountMinor
      ) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE };
      }

      const customerBalanceMinor = balanceValidation.resultingBalanceMinor;
      const merchantBalanceMinor =
        merchantAccount.balanceMinor + paymentIntent.amountMinor;

      transaction.update(cardRef, {
        balanceMinor: customerBalanceMinor,
      });
      transaction.update(merchantAccountRef, {
        balanceMinor: merchantBalanceMinor,
      });
      transaction.update(intentRef, {
        status: PAYMENT_INTENT_STATUS.SUCCESS,
        customerUid: uid,
        paidAt,
      });
      transaction.create(paymentTransactionRef, {
        type: 'QR_PAYMENT',
        paymentReference,
        customerUid: uid,
        merchantUid: paymentIntent.merchantUid,
        amountMinor: paymentIntent.amountMinor,
        currency: PAYMENT_CURRENCY,
        status: PAYMENT_INTENT_STATUS.SUCCESS,
        createdAt: paidAt,
      });

      return {
        outcome: PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
        idempotent: false,
        payment: toPaymentConfirmation(
          paymentReference,
          transactionId,
          {
            ...paymentIntent,
            status: PAYMENT_INTENT_STATUS.SUCCESS,
            paidAt,
          },
        ),
      };
    });
  }

  async function getPaymentStatus({ uid, paymentReference }) {
    if (!isValidPaymentReference(paymentReference)) {
      return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND };
    }

    const customerRef = db.collection('users').doc(uid);
    const intentRef = db.collection('paymentIntents').doc(paymentReference);
    const transactionId = buildQrTransactionId(paymentReference);
    const paymentTransactionRef = db
      .collection('transactions')
      .doc(transactionId);

    return db.runTransaction(async (transaction) => {
      const customerSnapshot = await transaction.get(customerRef);
      if (!customerSnapshot.exists) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY };
      }

      const customer = customerSnapshot.data();
      if (customer.role !== 'CUSTOMER') {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY };
      }

      const intentSnapshot = await transaction.get(intentRef);
      if (!intentSnapshot.exists) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND };
      }

      const paymentIntent = intentSnapshot.data();
      const paymentTransactionSnapshot = await transaction.get(
        paymentTransactionRef,
      );

      if (paymentIntent.status === PAYMENT_INTENT_STATUS.SUCCESS) {
        if (
          typeof paymentIntent.customerUid !== 'string' ||
          paymentIntent.customerUid.length === 0
        ) {
          return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT };
        }

        if (paymentIntent.customerUid !== uid) {
          return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND };
        }

        if (
          !paymentTransactionSnapshot.exists ||
          !isConsistentQrTransaction(
            paymentTransactionSnapshot.data(),
            paymentIntent,
            paymentReference,
            uid,
          )
        ) {
          return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT };
        }

        return {
          outcome: PAYMENT_INTENT_OUTCOMES.FOUND,
          payment: toPaymentConfirmation(
            paymentReference,
            transactionId,
            paymentIntent,
          ),
        };
      }

      if (customer.status !== 'ACTIVE') {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY };
      }

      if (paymentTransactionSnapshot.exists) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT };
      }

      let status = paymentIntent.status;
      if (status === PAYMENT_INTENT_STATUS.PENDING) {
        const expiresAt = toDate(paymentIntent.expiresAt);
        const checkedAt = clock();
        if (
          !expiresAt ||
          Number.isNaN(expiresAt.getTime()) ||
          !(checkedAt instanceof Date) ||
          Number.isNaN(checkedAt.getTime())
        ) {
          return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE };
        }

        if (expiresAt.getTime() <= checkedAt.getTime()) {
          status = PAYMENT_INTENT_STATUS.EXPIRED;
        }
      } else if (
        status !== PAYMENT_INTENT_STATUS.PROCESSING &&
        status !== PAYMENT_INTENT_STATUS.FAILED &&
        status !== PAYMENT_INTENT_STATUS.EXPIRED
      ) {
        return { outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE };
      }

      return {
        outcome: PAYMENT_INTENT_OUTCOMES.FOUND,
        payment: toMinimalPaymentStatus(paymentReference, status),
      };
    });
  }

  return {
    confirmPaymentIntent,
    createPaymentIntent,
    getPaymentIntent,
    getPaymentStatus,
    listPaymentIntents,
    previewPaymentIntent,
  };
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

async function listPaymentIntents(input) {
  return getDefaultService().listPaymentIntents(input);
}

async function previewPaymentIntent(input) {
  return getDefaultService().previewPaymentIntent(input);
}

async function confirmPaymentIntent(input) {
  return getDefaultService().confirmPaymentIntent(input);
}

async function getPaymentStatus(input) {
  return getDefaultService().getPaymentStatus(input);
}

module.exports = {
  PAYMENT_INTENT_OUTCOMES,
  PAYMENT_INTENT_STATUS,
  PAYMENT_EXECUTION_OUTCOMES,
  buildQrTransactionId,
  confirmPaymentIntent,
  createPaymentIntent,
  createPaymentService,
  getPaymentIntent,
  getPaymentStatus,
  listPaymentIntents,
  previewPaymentIntent,
};
