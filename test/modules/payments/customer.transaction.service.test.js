const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAYMENT_INTENT_OUTCOMES,
  createPaymentService,
} = require('../../../src/modules/payments/payment.service');

function makeFakeDb({ users, transactions, intents }) {
  const collections = {
    users: new Map(Object.entries(users)),
    transactions: new Map(Object.entries(transactions)),
    paymentIntents: new Map(Object.entries(intents)),
  };
  const transactionQueries = [];

  function document(collectionName, id) {
    return {
      id,
      async get() {
        const data = collections[collectionName].get(id);
        return { exists: data !== undefined, data: () => data };
      },
    };
  }

  const db = {
    collection(name) {
      return {
        doc(id) {
          return document(name, id);
        },
        where(field, operator, expected) {
          transactionQueries.push({ name, field, operator, expected });
          let limit = Infinity;
          return {
            orderBy(orderField, direction) {
              assert.equal(orderField, 'createdAt');
              assert.equal(direction, 'desc');
              return this;
            },
            limit(value) {
              limit = value;
              return this;
            },
            async get() {
              const docs = [...collections[name].entries()]
                .filter(([, data]) => data[field] === expected)
                .sort(([, left], [, right]) => right.createdAt - left.createdAt)
                .slice(0, limit)
                .map(([id, data]) => ({ id, data: () => data }));
              return { docs };
            },
          };
        },
      };
    },
  };

  return { db, transactionQueries };
}

function successfulPayment({ customerUid, merchantUid, amountMinor, paidAt }) {
  return {
    intent: {
      merchantUid,
      merchantName: `${merchantUid} Store`,
      amountMinor,
      currency: 'LKR',
      status: 'SUCCESS',
      paidAt,
    },
    transaction: {
      type: 'QR_PAYMENT',
      paymentReference: `payment-${amountMinor}`,
      customerUid,
      merchantUid,
      amountMinor,
      currency: 'LKR',
      status: 'SUCCESS',
      createdAt: paidAt,
    },
  };
}

test('lists only the authenticated customer QR transactions newest first', async () => {
  const older = successfulPayment({
    customerUid: 'customer1',
    merchantUid: 'merchant-a',
    amountMinor: 1250,
    paidAt: new Date('2026-11-14T10:00:00.000Z'),
  });
  const newer = successfulPayment({
    customerUid: 'customer1',
    merchantUid: 'merchant-b',
    amountMinor: 2500,
    paidAt: new Date('2026-11-15T10:00:00.000Z'),
  });
  const anotherCustomer = successfulPayment({
    customerUid: 'customer2',
    merchantUid: 'merchant-c',
    amountMinor: 9999,
    paidAt: new Date('2026-11-16T10:00:00.000Z'),
  });

  const { db, transactionQueries } = makeFakeDb({
    users: {
      customer1: { role: 'CUSTOMER', status: 'ACTIVE' },
      customer2: { role: 'CUSTOMER', status: 'ACTIVE' },
    },
    transactions: {
      'qr-payment--older': older.transaction,
      'qr-payment--newer': newer.transaction,
      'qr-payment--other': anotherCustomer.transaction,
    },
    intents: {
      [older.transaction.paymentReference]: older.intent,
      [newer.transaction.paymentReference]: newer.intent,
      [anotherCustomer.transaction.paymentReference]: anotherCustomer.intent,
    },
  });

  const result = await createPaymentService({ db }).listCustomerTransactions({
    uid: 'customer1',
    limit: 20,
  });

  assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.LISTED);
  assert.deepEqual(
    result.customerTransactions.map((transaction) => transaction.transactionId),
    ['qr-payment--newer', 'qr-payment--older'],
  );
  assert.deepEqual(result.customerTransactions[0], {
    transactionId: 'qr-payment--newer',
    paymentReference: newer.transaction.paymentReference,
    merchantName: 'merchant-b Store',
    amountMinor: 2500,
    currency: 'LKR',
    status: 'SUCCESS',
    createdAt: '2026-11-15T10:00:00.000Z',
  });
  assert.deepEqual(transactionQueries, [
    {
      name: 'transactions',
      field: 'customerUid',
      operator: '==',
      expected: 'customer1',
    },
  ]);
});

test('rejects non-customers before reading transaction records', async () => {
  const { db, transactionQueries } = makeFakeDb({
    users: { merchant1: { role: 'MERCHANT', status: 'ACTIVE' } },
    transactions: {},
    intents: {},
  });

  const result = await createPaymentService({ db }).listCustomerTransactions({
    uid: 'merchant1',
    limit: 20,
  });

  assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.ROLE_FORBIDDEN);
  assert.deepEqual(transactionQueries, []);
});

test('rejects inconsistent ledger and intent data instead of displaying it', async () => {
  const payment = successfulPayment({
    customerUid: 'customer1',
    merchantUid: 'merchant-a',
    amountMinor: 1250,
    paidAt: new Date('2026-11-14T10:00:00.000Z'),
  });
  payment.intent.amountMinor = 9999;
  const { db } = makeFakeDb({
    users: { customer1: { role: 'CUSTOMER', status: 'ACTIVE' } },
    transactions: { 'qr-payment--one': payment.transaction },
    intents: { [payment.transaction.paymentReference]: payment.intent },
  });

  await assert.rejects(
    createPaymentService({ db }).listCustomerTransactions({
      uid: 'customer1',
      limit: 20,
    }),
    /inconsistent/,
  );
});
