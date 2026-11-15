const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAYMENT_INTENT_OUTCOMES,
  PAYMENT_INTENT_STATUS,
  createPaymentService,
} = require('../../../src/modules/payments/payment.service');

function makeFakeDb({ users, intents = {} }) {
  let nextId = 0;
  const collectionAccesses = [];
  const writesRecorded = [];
  const collections = {
    users: new Map(Object.entries(users)),
    paymentIntents: new Map(Object.entries(intents)),
  };

  function makeRef(collectionName, id) {
    return {
      id,
      collectionName,
      get: async () => {
        const data = collections[collectionName].get(id);
        return {
          exists: data !== undefined,
          data: () => data,
        };
      },
    };
  }

  const db = {
    collection(name) {
      collectionAccesses.push(name);
      return {
        doc(id) {
          if (id === undefined) {
            id = `generated-reference-${++nextId}`;
          }
          return makeRef(name, id);
        },
        where(field, operator, expected) {
          assert.equal(field, 'merchantUid');
          assert.equal(operator, '==');
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
                .sort(([, left], [, right]) =>
                  new Date(right.createdAt) - new Date(left.createdAt),
                )
                .slice(0, limit)
                .map(([id, data]) => ({
                  id,
                  ref: makeRef(name, id),
                  exists: true,
                  data: () => data,
                }));
              return { docs };
            },
          };
        },
      };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        get: async (ref) => ref.get(),
        create: (ref, data) => {
          const write = { type: 'create', ref, data };
          writes.push(write);
          writesRecorded.push(write);
        },
        update: (ref, data) => {
          const write = { type: 'update', ref, data };
          writes.push(write);
          writesRecorded.push(write);
        },
      };
      const result = await callback(transaction);
      for (const write of writes) {
        const collection = 'paymentIntents';
        const prior = collections[collection].get(write.ref.id) || {};
        if (write.type === 'create' && collections[collection].has(write.ref.id)) {
          throw new Error('Document already exists');
        }
        collections[collection].set(write.ref.id, {
          ...prior,
          ...write.data,
        });
      }
      return result;
    },
  };

  return { db, collections, collectionAccesses, writesRecorded };
}

const merchant = {
  role: 'MERCHANT',
  status: 'ACTIVE',
  businessName: 'Test Merchant',
};

test('creates a pending intent without reading or writing balances', async () => {
  const now = new Date('2026-11-13T10:00:00.000Z');
  const { db, collections, collectionAccesses, writesRecorded } = makeFakeDb({
    users: { merchant1: merchant },
  });
  const service = createPaymentService({ db, clock: () => now });

  const result = await service.createPaymentIntent({
    uid: 'merchant1',
    amountMinor: 125000,
    currency: 'LKR',
    description: 'Order 123',
    expiresInSeconds: 900,
  });

  assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.CREATED);
  assert.equal(result.paymentIntent.merchantName, 'Test Merchant');
  assert.equal(result.paymentIntent.amountMinor, 125000);
  assert.equal(result.paymentIntent.status, PAYMENT_INTENT_STATUS.PENDING);
  assert.equal(result.paymentIntent.createdAt, now.toISOString());
  assert.equal(
    result.paymentIntent.expiresAt,
    '2026-11-13T10:15:00.000Z'
  );
  assert.equal(collections.paymentIntents.size, 1);
  assert.equal(
    collections.paymentIntents.get(result.paymentIntent.paymentReference)
      .merchantUid,
    'merchant1'
  );
  assert.deepEqual([...new Set(collectionAccesses)].sort(), [
    'paymentIntents',
    'users',
  ]);
  assert.deepEqual(
    writesRecorded.map(({ type, ref }) => ({
      type,
      collectionName: ref.collectionName,
    })),
    [{ type: 'create', collectionName: 'paymentIntents' }],
  );
});

test('does not create intents for customers or inactive accounts', async () => {
  const { db, collections } = makeFakeDb({
    users: {
      customer1: { role: 'CUSTOMER', status: 'ACTIVE' },
      inactiveMerchant: { ...merchant, status: 'DISABLED' },
    },
  });
  const service = createPaymentService({ db });

  for (const uid of ['customer1', 'inactiveMerchant']) {
    const result = await service.createPaymentIntent({
      uid,
      amountMinor: 100,
      currency: 'LKR',
      expiresInSeconds: 900,
    });
    assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.ROLE_FORBIDDEN);
  }
  assert.equal(collections.paymentIntents.size, 0);
});

test('retrieves an owned intent and hides another merchant’s intent', async () => {
  const { db } = makeFakeDb({
    users: { merchant1: merchant, merchant2: merchant },
    intents: {
      ref1: {
        merchantUid: 'merchant1',
        merchantName: 'Test Merchant',
        amountMinor: 100,
        currency: 'LKR',
        status: PAYMENT_INTENT_STATUS.PENDING,
        createdAt: new Date('2026-11-13T10:00:00.000Z'),
        expiresAt: new Date('2026-11-13T10:15:00.000Z'),
      },
    },
  });
  const service = createPaymentService({
    db,
    clock: () => new Date('2026-11-13T10:01:00.000Z'),
  });

  const own = await service.getPaymentIntent({
    uid: 'merchant1',
    paymentReference: 'ref1',
  });
  const another = await service.getPaymentIntent({
    uid: 'merchant2',
    paymentReference: 'ref1',
  });

  assert.equal(own.outcome, PAYMENT_INTENT_OUTCOMES.FOUND);
  assert.equal(own.paymentIntent.paymentReference, 'ref1');
  assert.equal(another.outcome, PAYMENT_INTENT_OUTCOMES.NOT_FOUND);
});

test('returns not found safely for unknown and malformed payment references', async () => {
  const { db } = makeFakeDb({ users: { merchant1: merchant } });
  const service = createPaymentService({ db });

  const unknown = await service.getPaymentIntent({
    uid: 'merchant1',
    paymentReference: 'unknown-reference',
  });
  const malformed = await service.getPaymentIntent({
    uid: 'merchant1',
    paymentReference: 'invalid/reference',
  });

  assert.equal(unknown.outcome, PAYMENT_INTENT_OUTCOMES.NOT_FOUND);
  assert.equal(malformed.outcome, PAYMENT_INTENT_OUTCOMES.NOT_FOUND);
});

test('marks an overdue pending intent expired during retrieval', async () => {
  const { db, collections } = makeFakeDb({
    users: { merchant1: merchant },
    intents: {
      ref1: {
        merchantUid: 'merchant1',
        merchantName: 'Test Merchant',
        amountMinor: 100,
        currency: 'LKR',
        status: PAYMENT_INTENT_STATUS.PENDING,
        createdAt: new Date('2026-11-13T10:00:00.000Z'),
        expiresAt: new Date('2026-11-13T10:15:00.000Z'),
      },
    },
  });
  const service = createPaymentService({
    db,
    clock: () => new Date('2026-11-13T10:15:00.000Z'),
  });

  const result = await service.getPaymentIntent({
    uid: 'merchant1',
    paymentReference: 'ref1',
  });

  assert.equal(result.paymentIntent.status, PAYMENT_INTENT_STATUS.EXPIRED);
  assert.equal(
    collections.paymentIntents.get('ref1').status,
    PAYMENT_INTENT_STATUS.EXPIRED
  );
});

test('preserves processing status for Member 4 to resolve', async () => {
  const { db, collections } = makeFakeDb({
    users: { merchant1: merchant },
    intents: {
      ref1: {
        merchantUid: 'merchant1',
        merchantName: 'Test Merchant',
        amountMinor: 100,
        currency: 'LKR',
        status: PAYMENT_INTENT_STATUS.PROCESSING,
        createdAt: new Date('2026-11-13T10:00:00.000Z'),
        expiresAt: new Date('2026-11-13T10:01:00.000Z'),
      },
    },
  });
  const service = createPaymentService({
    db,
    clock: () => new Date('2026-11-13T10:15:00.000Z'),
  });

  const result = await service.getPaymentIntent({
    uid: 'merchant1',
    paymentReference: 'ref1',
  });

  assert.equal(result.paymentIntent.status, PAYMENT_INTENT_STATUS.PROCESSING);
  assert.equal(
    collections.paymentIntents.get('ref1').status,
    PAYMENT_INTENT_STATUS.PROCESSING,
  );
});

test('does not expire an intent that is already successful', async () => {
  const { db, collections } = makeFakeDb({
    users: { merchant1: merchant },
    intents: {
      ref1: {
        merchantUid: 'merchant1',
        merchantName: 'Test Merchant',
        amountMinor: 100,
        currency: 'LKR',
        status: PAYMENT_INTENT_STATUS.SUCCESS,
        createdAt: new Date('2026-11-13T10:00:00.000Z'),
        expiresAt: new Date('2026-11-13T10:01:00.000Z'),
        paidAt: new Date('2026-11-13T10:00:30.000Z'),
      },
    },
  });
  const service = createPaymentService({
    db,
    clock: () => new Date('2026-11-13T10:15:00.000Z'),
  });

  const result = await service.getPaymentIntent({
    uid: 'merchant1',
    paymentReference: 'ref1',
  });

  assert.equal(result.paymentIntent.status, PAYMENT_INTENT_STATUS.SUCCESS);
  assert.equal(result.paymentIntent.paidAt, '2026-11-13T10:00:30.000Z');
  assert.equal(
    collections.paymentIntents.get('ref1').status,
    PAYMENT_INTENT_STATUS.SUCCESS
  );
});

test('lists only owned merchant intents newest first and expires overdue pending', async () => {
  const now = new Date('2026-11-13T10:15:00.000Z');
  const { db, collections } = makeFakeDb({
    users: { merchant1: merchant, merchant2: merchant },
    intents: {
      oldPending: {
        merchantUid: 'merchant1',
        merchantName: 'Test Merchant',
        amountMinor: 100,
        currency: 'LKR',
        status: PAYMENT_INTENT_STATUS.PENDING,
        createdAt: new Date('2026-11-13T10:00:00.000Z'),
        expiresAt: new Date('2026-11-13T10:01:00.000Z'),
      },
      latestSuccess: {
        merchantUid: 'merchant1',
        merchantName: 'Test Merchant',
        amountMinor: 250,
        currency: 'LKR',
        status: PAYMENT_INTENT_STATUS.SUCCESS,
        createdAt: new Date('2026-11-13T10:10:00.000Z'),
        expiresAt: new Date('2026-11-13T10:25:00.000Z'),
      },
      anotherMerchant: {
        merchantUid: 'merchant2',
        merchantName: 'Other Merchant',
        amountMinor: 300,
        currency: 'LKR',
        status: PAYMENT_INTENT_STATUS.PENDING,
        createdAt: new Date('2026-11-13T10:12:00.000Z'),
        expiresAt: new Date('2026-11-13T10:20:00.000Z'),
      },
    },
  });
  const service = createPaymentService({ db, clock: () => now });

  const result = await service.listPaymentIntents({ uid: 'merchant1', limit: 20 });

  assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.LISTED);
  assert.deepEqual(
    result.paymentIntents.map(({ paymentReference, status }) => ({
      paymentReference,
      status,
    })),
    [
      { paymentReference: 'latestSuccess', status: PAYMENT_INTENT_STATUS.SUCCESS },
      { paymentReference: 'oldPending', status: PAYMENT_INTENT_STATUS.EXPIRED },
    ],
  );
  assert.equal(
    collections.paymentIntents.get('oldPending').status,
    PAYMENT_INTENT_STATUS.EXPIRED,
  );
});

test('does not list intents for customers or inactive merchants', async () => {
  const { db } = makeFakeDb({
    users: {
      customer1: { role: 'CUSTOMER', status: 'ACTIVE' },
      inactiveMerchant: { ...merchant, status: 'DISABLED' },
    },
  });
  const service = createPaymentService({ db });

  for (const uid of ['customer1', 'inactiveMerchant']) {
    const result = await service.listPaymentIntents({ uid });
    assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.ROLE_FORBIDDEN);
  }
});
