const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAYMENT_EXECUTION_OUTCOMES,
  PAYMENT_INTENT_OUTCOMES,
  PAYMENT_INTENT_STATUS,
  buildQrTransactionId,
  createPaymentService,
} = require('../../../src/modules/payments/payment.service');
const {
  createTopupService,
} = require('../../../src/modules/topups/topup.service');

const NOW = new Date('2026-11-15T10:00:00.000Z');
const FUTURE = new Date('2026-11-15T11:00:00.000Z');
const PAST = new Date('2026-11-15T09:00:00.000Z');

function makeFakeDb(seed = {}, { failCommits = 0 } = {}) {
  let nextId = 0;
  let transactionQueue = Promise.resolve();
  const collectionAccesses = [];
  const writesRecorded = [];
  const collections = {};

  for (const [name, documents] of Object.entries(seed)) {
    collections[name] = new Map(Object.entries(documents));
  }

  function getCollection(name) {
    if (!collections[name]) collections[name] = new Map();
    return collections[name];
  }

  function makeRef(collectionName, id) {
    return { collectionName, id };
  }

  const db = {
    collection(name) {
      collectionAccesses.push(name);
      getCollection(name);
      return {
        doc(id) {
          return makeRef(name, id ?? `generated-${++nextId}`);
        },
      };
    },
    runTransaction(callback) {
      const run = async () => {
        const writes = [];
        const transaction = {
          async get(ref) {
            const data = getCollection(ref.collectionName).get(ref.id);
            return {
              exists: data !== undefined,
              id: ref.id,
              data: () => data,
            };
          },
          update(ref, data) {
            const write = { type: 'update', ref, data };
            writes.push(write);
            writesRecorded.push(write);
          },
          create(ref, data) {
            const write = { type: 'create', ref, data };
            writes.push(write);
            writesRecorded.push(write);
          },
        };

        const result = await callback(transaction);
        if (failCommits > 0) {
          failCommits -= 1;
          throw new Error('simulated transaction commit failure');
        }

        for (const write of writes) {
          const collection = getCollection(write.ref.collectionName);
          if (write.type === 'create' && collection.has(write.ref.id)) {
            throw new Error('document already exists');
          }
        }
        for (const write of writes) {
          const collection = getCollection(write.ref.collectionName);
          const existing = collection.get(write.ref.id) || {};
          collection.set(write.ref.id, { ...existing, ...write.data });
        }

        return result;
      };

      const resultPromise = transactionQueue.then(run, run);
      transactionQueue = resultPromise.catch(() => {});
      return resultPromise;
    },
  };

  return { db, collections, collectionAccesses, writesRecorded };
}

function makeScenario({
  enabled = true,
  failCommits = 0,
  spendingLimitProvider,
  notifications,
} = {}) {
  const paymentReference = 'intent-reference';
  const { db, collections, collectionAccesses, writesRecorded } = makeFakeDb(
    {
      users: {
        customer1: { role: 'CUSTOMER', status: 'ACTIVE' },
        merchant1: {
          role: 'MERCHANT',
          status: 'ACTIVE',
          businessName: 'Test Merchant',
        },
      },
      cards: {
        customer1: {
          ownerId: 'customer1',
          balance: 1000,
          status: 'ACTIVE',
          expiresAt: FUTURE,
        },
      },
      merchantAccounts: {
        merchant1: {
          balanceMinor: 10000,
          currency: 'LKR',
          status: 'ACTIVE',
        },
      },
      paymentIntents: {
        [paymentReference]: {
          merchantUid: 'merchant1',
          merchantName: 'Test Merchant',
          amountMinor: 12550,
          currency: 'LKR',
          status: PAYMENT_INTENT_STATUS.PENDING,
          createdAt: PAST,
          expiresAt: FUTURE,
        },
      },
      transactions: {},
    },
    { failCommits },
  );
  const serviceOptions = {
    db,
    clock: () => NOW,
    executionEnabled: () => enabled,
  };
  if (spendingLimitProvider) {
    serviceOptions.spendingLimitProvider = spendingLimitProvider;
  }
  if (notifications) serviceOptions.notifications = notifications;
  const service = createPaymentService(serviceOptions);

  return {
    collections,
    collectionAccesses,
    db,
    paymentReference,
    service,
    writesRecorded,
  };
}

async function confirm(scenario, uid = 'customer1') {
  return scenario.service.confirmPaymentIntent({
    uid,
    paymentReference: scenario.paymentReference,
  });
}

async function getStatus(scenario, uid = 'customer1') {
  return scenario.service.getPaymentStatus({
    uid,
    paymentReference: scenario.paymentReference,
  });
}

test('post-commit notifications reach payer and merchant once and cannot fail payment', async () => {
  const sent = [];
  const scenario = makeScenario({ notifications: {
    notifyPaymentSuccess: async uid => { sent.push(['PAYMENT_SUCCESS', uid]); throw Error('FCM offline'); },
    notifyPaymentReceived: async uid => { sent.push(['PAYMENT_RECEIVED', uid]); return { status: 'MESSAGING_FAILED' }; },
  } });
  assert.equal((await confirm(scenario)).outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal((await confirm(scenario)).idempotent, true);
  assert.deepEqual(sent, [['PAYMENT_SUCCESS', 'customer1'], ['PAYMENT_RECEIVED', 'merchant1']]);
  assert.equal(scenario.collections.cards.get('customer1').balance, 874.5);
  assert.equal(scenario.collections.merchantAccounts.get('merchant1').balanceMinor, 22550);
});

test('failed QR payment sends no notifications', async () => {
  const sent = [];
  const scenario = makeScenario({ notifications: {
    notifyPaymentSuccess: async () => sent.push('payer'),
    notifyPaymentReceived: async () => sent.push('merchant'),
  } });
  scenario.collections.cards.get('customer1').balance = 0;
  assert.notEqual((await confirm(scenario)).outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.deepEqual(sent, []);
});

test('atomically executes a QR payment using integer LKR cents', async () => {
  const scenario = makeScenario();

  const result = await confirm(scenario);

  assert.equal(result.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(result.idempotent, false);
  assert.deepEqual(result.payment, {
    transactionId: buildQrTransactionId(scenario.paymentReference),
    paymentReference: scenario.paymentReference,
    merchantName: 'Test Merchant',
    amountMinor: 12550,
    currency: 'LKR',
    status: PAYMENT_INTENT_STATUS.SUCCESS,
    paidAt: NOW.toISOString(),
  });
  assert.equal(
    scenario.collections.cards.get('customer1').balance,
    874.5,
  );
  assert.equal(
    scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
    22550,
  );
  const intent = scenario.collections.paymentIntents.get(
    scenario.paymentReference,
  );
  assert.equal(intent.status, PAYMENT_INTENT_STATUS.SUCCESS);
  assert.equal(intent.customerUid, 'customer1');
  assert.equal(intent.paidAt, NOW);
  assert.deepEqual(
    scenario.collections.transactions.get(
      buildQrTransactionId(scenario.paymentReference),
    ),
    {
      type: 'QR_PAYMENT',
      paymentReference: scenario.paymentReference,
      customerUid: 'customer1',
      merchantUid: 'merchant1',
      amountMinor: 12550,
      currency: 'LKR',
      status: PAYMENT_INTENT_STATUS.SUCCESS,
      createdAt: NOW,
    },
  );
});

test('allows a payment that leaves exactly the retained balance', async () => {
  const scenario = makeScenario();
  scenario.collections.cards.get('customer1').balance = 625.5;

  const result = await confirm(scenario);

  assert.equal(result.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(scenario.collections.cards.get('customer1').balance, 500);
});

test('enforces retained-balance outcomes during payment execution', async () => {
  const cases = [
    [200_000, 100_000, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED, 100_000],
    [200_000, 150_000, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED, 50_000],
    [200_000, 150_100, PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED],
    [50_000, 1_000, PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED],
    [51_000, 1_000, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED, 50_000],
    [40_000, 1_000, PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED],
    [10_000, 20_000, PAYMENT_EXECUTION_OUTCOMES.INSUFFICIENT_BALANCE],
  ];

  for (const [balanceMinor, amountMinor, outcome, resultingBalanceMinor] of cases) {
    const scenario = makeScenario();
    scenario.collections.cards.get('customer1').balance = balanceMinor / 100;
    scenario.collections.paymentIntents.get(
      scenario.paymentReference,
    ).amountMinor = amountMinor;

    const result = await confirm(scenario);

    assert.equal(result.outcome, outcome);
    assert.equal(
      scenario.collections.cards.get('customer1').balance,
      (resultingBalanceMinor ?? balanceMinor) / 100,
    );
    assert.equal(
      scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
      outcome === PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED
        ? 10_000 + amountMinor
        : 10_000,
    );
    assert.equal(
      scenario.collections.transactions.size,
      outcome === PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED ? 1 : 0,
    );
    assert.equal(
      scenario.collections.paymentIntents.get(scenario.paymentReference).status,
      outcome === PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED
        ? PAYMENT_INTENT_STATUS.SUCCESS
        : PAYMENT_INTENT_STATUS.PENDING,
    );
  }
});

test('concurrent distinct payments cannot spend below the retained balance', async () => {
  const scenario = makeScenario();
  const first = scenario.collections.paymentIntents.get(scenario.paymentReference);
  first.amountMinor = 40_000;
  scenario.collections.paymentIntents.set('second-intent', { ...first });

  const results = await Promise.all([
    confirm(scenario),
    scenario.service.confirmPaymentIntent({
      uid: 'customer1', paymentReference: 'second-intent',
    }),
  ]);

  assert.deepEqual(results.map(({ outcome }) => outcome).sort(), [
    PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED,
    PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
  ].sort());
  assert.equal(scenario.collections.cards.get('customer1').balance, 600);
  assert.equal(scenario.collections.merchantAccounts.get('merchant1').balanceMinor, 50_000);
  assert.equal(scenario.collections.transactions.size, 1);
  assert.equal(
    [...scenario.collections.paymentIntents.values()].filter(
      (intent) => intent.status === PAYMENT_INTENT_STATUS.SUCCESS,
    ).length,
    1,
  );
});

test('rejects insufficient balance without changing financial documents', async () => {
  const scenario = makeScenario();
  scenario.collections.cards.get('customer1').balance = 125.49;

  const result = await confirm(scenario);

  assert.equal(
    result.outcome,
    PAYMENT_EXECUTION_OUTCOMES.INSUFFICIENT_BALANCE,
  );
  assert.equal(scenario.collections.cards.get('customer1').balance, 125.49);
  assert.equal(
    scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
    10000,
  );
  assert.equal(scenario.collections.transactions.size, 0);
});

test('enforces server-resolved payment limits before financial writes', async () => {
  for (const [amountMinor, outcome] of [
    [500, PAYMENT_EXECUTION_OUTCOMES.PAYMENT_BELOW_MINIMUM],
    [2_000_001, PAYMENT_EXECUTION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED],
    [2_500_000, PAYMENT_EXECUTION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED],
  ]) {
    const scenario = makeScenario();
    scenario.collections.cards.get('customer1').balance = 30_000;
    scenario.collections.paymentIntents.get(
      scenario.paymentReference,
    ).amountMinor = amountMinor;

    const result = await confirm(scenario);

    assert.equal(result.outcome, outcome);
    assert.equal(
      scenario.collections.cards.get('customer1').balance,
      30_000,
    );
    assert.equal(
      scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
      10_000,
    );
    assert.equal(
      scenario.collections.paymentIntents.get(scenario.paymentReference).status,
      PAYMENT_INTENT_STATUS.PENDING,
    );
    assert.equal(scenario.collections.transactions.size, 0);
    assert.deepEqual(scenario.writesRecorded, []);
  }
});

test('supports an injected trusted customer limit', async () => {
  let providerContext;
  const scenario = makeScenario({
    spendingLimitProvider: async (context) => {
      providerContext = context;
      return 12_000;
    },
  });

  const result = await confirm(scenario);

  assert.equal(
    result.outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED,
  );
  assert.deepEqual(providerContext, {
    customerUid: 'customer1',
    customerProfile: { role: 'CUSTOMER', status: 'ACTIVE' },
  });
  assert.deepEqual(scenario.writesRecorded, []);
});

test('maps a malformed trusted limit to payment unavailable without writes', async () => {
  for (const trustedLimit of [0, 1.5, '2000000']) {
    const scenario = makeScenario({
      spendingLimitProvider: async () => trustedLimit,
    });

    assert.equal(
      (await confirm(scenario)).outcome,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE,
    );
    assert.deepEqual(scenario.writesRecorded, []);
  }
});

test('ignores client-shaped amount and policy fields during confirmation', async () => {
  const scenario = makeScenario();

  const result = await scenario.service.confirmPaymentIntent({
    uid: 'customer1',
    paymentReference: scenario.paymentReference,
    amountMinor: 500,
    maxLimitMinor: 500,
    minRetainedBalanceMinor: 0,
  });

  assert.equal(result.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(result.payment.amountMinor, 12_550);
});

test('rejects frozen and expired cards', async () => {
  const frozen = makeScenario();
  frozen.collections.cards.get('customer1').status = 'FROZEN';
  assert.equal(
    (await confirm(frozen)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.CARD_FROZEN,
  );

  const expired = makeScenario();
  expired.collections.cards.get('customer1').expiresAt = NOW;
  assert.equal(
    (await confirm(expired)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.CARD_EXPIRED,
  );

  const wrongOwner = makeScenario();
  wrongOwner.collections.cards.get('customer1').ownerId = 'customer2';
  assert.equal(
    (await confirm(wrongOwner)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY,
  );
});

test('requires active customer, merchant, and pre-existing merchant account', async () => {
  for (const mutate of [
    (scenario) => scenario.collections.users.delete('customer1'),
    (scenario) => {
      scenario.collections.users.get('customer1').status = 'DISABLED';
    },
    (scenario) => scenario.collections.cards.delete('customer1'),
  ]) {
    const scenario = makeScenario();
    mutate(scenario);
    assert.equal(
      (await confirm(scenario)).outcome,
      PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY,
    );
  }

  for (const mutate of [
    (scenario) => scenario.collections.users.delete('merchant1'),
    (scenario) => {
      scenario.collections.users.get('merchant1').status = 'DISABLED';
    },
    (scenario) => scenario.collections.merchantAccounts.delete('merchant1'),
    (scenario) => {
      scenario.collections.merchantAccounts.get('merchant1').status = 'FROZEN';
    },
  ]) {
    const scenario = makeScenario();
    mutate(scenario);
    assert.equal(
      (await confirm(scenario)).outcome,
      PAYMENT_EXECUTION_OUTCOMES.MERCHANT_UNAVAILABLE,
    );
  }
});

test('expires overdue intents and rejects invalid payment intent data', async () => {
  const expired = makeScenario();
  expired.collections.paymentIntents.get(expired.paymentReference).expiresAt = NOW;
  assert.equal(
    (await confirm(expired)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_EXPIRED,
  );
  assert.equal(
    expired.collections.paymentIntents.get(expired.paymentReference).status,
    PAYMENT_INTENT_STATUS.EXPIRED,
  );

  for (const mutate of [
    (intent) => { intent.amountMinor = 0; },
    (intent) => { intent.amountMinor = 1.5; },
    (intent) => { intent.currency = 'USD'; },
    (intent) => { intent.expiresAt = 'invalid'; },
  ]) {
    const scenario = makeScenario();
    mutate(scenario.collections.paymentIntents.get(scenario.paymentReference));
    assert.equal(
      (await confirm(scenario)).outcome,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE,
    );
  }

  const missing = makeScenario();
  missing.collections.paymentIntents.clear();
  assert.equal(
    (await confirm(missing)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND,
  );

  const malformed = makeScenario();
  const malformedResult = await malformed.service.confirmPaymentIntent({
    uid: 'customer1',
    paymentReference: 'invalid/reference',
  });
  assert.equal(
    malformedResult.outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND,
  );
});

test('returns a non-retryable outcome for a terminally failed intent', async () => {
  const scenario = makeScenario();
  scenario.collections.paymentIntents.get(
    scenario.paymentReference,
  ).status = PAYMENT_INTENT_STATUS.FAILED;

  const result = await confirm(scenario);

  assert.equal(
    result.outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_FAILED,
  );
  assert.deepEqual(scenario.writesRecorded, []);
  assert.equal(scenario.collections.transactions.size, 0);
});

test('uses the existing rupee balance for exact fractional-rupee payments', async () => {
  const scenario = makeScenario();
  const card = scenario.collections.cards.get('customer1');
  card.balance = 1_000.55;
  scenario.collections.paymentIntents.get(
    scenario.paymentReference,
  ).amountMinor = 12_555;

  const result = await confirm(scenario);

  assert.equal(result.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(scenario.collections.cards.get('customer1').balance, 875);
  assert.equal('balanceMinor' in card, false);
  assert.equal(
    scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
    22_555,
  );
});

test('executes whole-rupee payments against the rupee balance', async () => {
  const scenario = makeScenario();
  scenario.collections.paymentIntents.get(
    scenario.paymentReference,
  ).amountMinor = 12_500;

  const result = await confirm(scenario);

  assert.equal(result.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(scenario.collections.cards.get('customer1').balance, 875);
  assert.equal(
    scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
    22_500,
  );
});

test('spends the same rupee balance credited by a successful top-up', async () => {
  const scenario = makeScenario();
  scenario.db.collection('topups');
  scenario.collections.topups.set('topup-reference', {
    uid: 'customer1',
    requestedAmount: 120,
    currency: 'LKR',
    status: 'PENDING',
    sessionId: 'session-reference',
    createdAt: PAST,
    updatedAt: PAST,
  });
  const topupService = createTopupService({
    db: scenario.db,
    gateway: {},
    now: () => NOW,
  });

  const topup = await topupService.applyEvent({
    clientReference: 'topup-reference',
    sessionId: 'session-reference',
    paymentId: 'payment-reference',
    eventId: 'event-reference',
    requestedAmount: 120,
    amount: 120,
    currency: 'LKR',
    status: 'SUCCESS',
    message: 'Approved',
  });
  const payment = await confirm(scenario);

  assert.equal(topup.status, 'SUCCESS');
  assert.equal(payment.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(scenario.collections.cards.get('customer1').balance, 994.5);
  assert.equal(
    scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
    22_550,
  );
  assert.equal(scenario.collections.transactions.size, 2);
});

test('rejects missing, unsafe, and fractional-cent customer balances', async () => {
  for (const balance of [
    undefined,
    NaN,
    Infinity,
    -1,
    500.001,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const scenario = makeScenario();
    scenario.collections.cards.get('customer1').balance = balance;

    const result = await confirm(scenario);

    assert.equal(
      result.outcome,
      PAYMENT_EXECUTION_OUTCOMES.INVALID_BALANCE_SCHEMA,
    );
    assert.equal(scenario.collections.transactions.size, 0);
    assert.equal(
      scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
      10_000,
    );
  }
});

test('accepts missing or LKR card currency and rejects explicit non-LKR', async () => {
  const implicitLkr = makeScenario();
  assert.equal(
    (await confirm(implicitLkr)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
  );

  const explicitLkr = makeScenario();
  explicitLkr.collections.cards.get('customer1').currency = 'LKR';
  assert.equal(
    (await confirm(explicitLkr)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
  );

  for (const currency of ['USD', '', null]) {
    const unsupported = makeScenario();
    unsupported.collections.cards.get('customer1').currency = currency;
    assert.equal(
      (await confirm(unsupported)).outcome,
      PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY,
    );
    assert.equal(unsupported.collections.transactions.size, 0);
  }
});

test('returns an idempotent result for a duplicate request by the original payer', async () => {
  const scenario = makeScenario();
  const first = await confirm(scenario);
  const balancesAfterFirst = {
    customer: scenario.collections.cards.get('customer1').balance,
    merchant: scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
  };

  const duplicate = await confirm(scenario);

  assert.equal(first.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(duplicate.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(duplicate.idempotent, true);
  assert.deepEqual(duplicate.payment, first.payment);
  assert.deepEqual(
    {
      customer: scenario.collections.cards.get('customer1').balance,
      merchant: scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
    },
    balancesAfterFirst,
  );
  assert.equal(scenario.collections.transactions.size, 1);
});

test('does not reapply current amount or balance policies to a completed payment', async () => {
  let providerCalls = 0;
  const scenario = makeScenario({
    spendingLimitProvider: async () => {
      providerCalls += 1;
      return providerCalls === 1 ? 2_000_000 : 1;
    },
  });

  const first = await confirm(scenario);
  scenario.collections.cards.get('customer1').balance = 0;
  const duplicate = await confirm(scenario);

  assert.equal(first.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(duplicate.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
  assert.equal(duplicate.idempotent, true);
  assert.equal(providerCalls, 1);
  assert.equal(scenario.collections.cards.get('customer1').balance, 0);
});

test('serializable concurrent confirmations transfer funds only once', async () => {
  const scenario = makeScenario();

  const results = await Promise.all([confirm(scenario), confirm(scenario)]);

  assert.deepEqual(
    results.map(({ outcome }) => outcome),
    [
      PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
      PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
    ],
  );
  assert.equal(results.filter(({ idempotent }) => idempotent).length, 1);
  assert.equal(scenario.collections.cards.get('customer1').balance, 874.5);
  assert.equal(
    scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
    22550,
  );
  assert.equal(scenario.collections.transactions.size, 1);
});

test('does not report success to a different customer after payment', async () => {
  const scenario = makeScenario();
  scenario.collections.users.set('customer2', {
    role: 'CUSTOMER',
    status: 'ACTIVE',
  });
  scenario.collections.cards.set('customer2', {
    ownerId: 'customer2',
    balance: 500,
    status: 'ACTIVE',
    expiresAt: FUTURE,
  });

  assert.equal(
    (await confirm(scenario, 'customer1')).outcome,
    PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
  );
  assert.equal(
    (await confirm(scenario, 'customer2')).outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_ALREADY_PAID,
  );
  assert.equal(
    scenario.collections.cards.get('customer2').balance,
    500,
  );
});

test('rejects unsafe balances, unsafe amounts, and merchant overflow', async () => {
  const unsafeCustomer = makeScenario();
  unsafeCustomer.collections.cards.get('customer1').balance = 1.005;
  assert.equal(
    (await confirm(unsafeCustomer)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.INVALID_BALANCE_SCHEMA,
  );

  const unsafeMerchant = makeScenario();
  unsafeMerchant.collections.merchantAccounts.get('merchant1').balanceMinor =
    1.5;
  assert.equal(
    (await confirm(unsafeMerchant)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.INVALID_BALANCE_SCHEMA,
  );

  const unsafeAmount = makeScenario();
  unsafeAmount.collections.paymentIntents.get(
    unsafeAmount.paymentReference,
  ).amountMinor = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(
    (await confirm(unsafeAmount)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE,
  );

  const overflow = makeScenario();
  overflow.collections.paymentIntents.get(
    overflow.paymentReference,
  ).amountMinor = 1_000;
  overflow.collections.merchantAccounts.get('merchant1').balanceMinor =
    Number.MAX_SAFE_INTEGER;
  assert.equal(
    (await confirm(overflow)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE,
  );
});

test('rejects completed payments with missing or inconsistent ledger records', async () => {
  for (const addRecord of [false, true]) {
    const scenario = makeScenario();
    const intent = scenario.collections.paymentIntents.get(
      scenario.paymentReference,
    );
    intent.status = PAYMENT_INTENT_STATUS.SUCCESS;
    intent.customerUid = 'customer1';
    intent.paidAt = NOW;
    if (addRecord) {
      scenario.collections.transactions.set(
        buildQrTransactionId(scenario.paymentReference),
        {
          type: 'QR_PAYMENT',
          paymentReference: scenario.paymentReference,
          customerUid: 'customer1',
          merchantUid: 'merchant1',
          amountMinor: 999,
          currency: 'LKR',
          status: PAYMENT_INTENT_STATUS.SUCCESS,
          createdAt: NOW,
        },
      );
    }

    assert.equal(
      (await confirm(scenario)).outcome,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT,
    );
  }
});

test('rolls back every staged write when transaction commit fails', async () => {
  const scenario = makeScenario({ failCommits: 1 });

  await assert.rejects(confirm(scenario), /commit failure/);

  assert.equal(scenario.collections.cards.get('customer1').balance, 1000);
  assert.equal(
    scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
    10000,
  );
  assert.equal(
    scenario.collections.paymentIntents.get(scenario.paymentReference).status,
    PAYMENT_INTENT_STATUS.PENDING,
  );
  assert.equal(scenario.collections.transactions.size, 0);
});

test('disabled execution flag prevents all Firestore access and writes', async () => {
  const scenario = makeScenario({ enabled: false });

  const result = await confirm(scenario);

  assert.equal(
    result.outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE,
  );
  assert.deepEqual(scenario.collectionAccesses, []);
  assert.deepEqual(scenario.writesRecorded, []);
});

test('execution feature flag is disabled by default', async () => {
  const priorValue = process.env.VPAY_QR_PAYMENT_EXECUTION_ENABLED;
  delete process.env.VPAY_QR_PAYMENT_EXECUTION_ENABLED;
  const { db, collectionAccesses } = makeFakeDb();
  const service = createPaymentService({ db, clock: () => NOW });

  try {
    const result = await service.confirmPaymentIntent({
      uid: 'customer1',
      paymentReference: 'intent-reference',
    });
    assert.equal(
      result.outcome,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE,
    );
    assert.deepEqual(collectionAccesses, []);
  } finally {
    if (priorValue === undefined) {
      delete process.env.VPAY_QR_PAYMENT_EXECUTION_ENABLED;
    } else {
      process.env.VPAY_QR_PAYMENT_EXECUTION_ENABLED = priorValue;
    }
  }
});

test('retrieves a successful payment for its original customer without writes', async () => {
  const scenario = makeScenario();
  await confirm(scenario);
  const writesAfterPayment = scenario.writesRecorded.length;
  const customerBalance = scenario.collections.cards.get(
    'customer1',
  ).balance;
  const merchantBalance = scenario.collections.merchantAccounts.get(
    'merchant1',
  ).balanceMinor;

  const first = await getStatus(scenario);
  const repeated = await getStatus(scenario);

  assert.equal(first.outcome, PAYMENT_INTENT_OUTCOMES.FOUND);
  assert.deepEqual(first.payment, {
    transactionId: buildQrTransactionId(scenario.paymentReference),
    paymentReference: scenario.paymentReference,
    merchantName: 'Test Merchant',
    amountMinor: 12550,
    currency: 'LKR',
    status: PAYMENT_INTENT_STATUS.SUCCESS,
    paidAt: NOW.toISOString(),
  });
  assert.deepEqual(repeated.payment, first.payment);
  assert.equal(scenario.writesRecorded.length, writesAfterPayment);
  assert.equal(
    scenario.collections.cards.get('customer1').balance,
    customerBalance,
  );
  assert.equal(
    scenario.collections.merchantAccounts.get('merchant1').balanceMinor,
    merchantBalance,
  );
});

test('successful status lookup works while execution is disabled', async () => {
  const scenario = makeScenario();
  await confirm(scenario);
  const statusService = createPaymentService({
    db: scenario.db,
    clock: () => NOW,
    executionEnabled: () => false,
  });

  const result = await statusService.getPaymentStatus({
    uid: 'customer1',
    paymentReference: scenario.paymentReference,
  });

  assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.FOUND);
  assert.equal(result.payment.status, PAYMENT_INTENT_STATUS.SUCCESS);
});

test('hides a successful payment from another customer', async () => {
  const scenario = makeScenario();
  scenario.collections.users.set('customer2', {
    role: 'CUSTOMER',
    status: 'ACTIVE',
  });
  await confirm(scenario);

  const result = await getStatus(scenario, 'customer2');

  assert.equal(
    result.outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND,
  );
  assert.equal('payment' in result, false);
});

test('status lookup detects missing and inconsistent successful ledgers', async () => {
  const missing = makeScenario();
  await confirm(missing);
  missing.collections.transactions.clear();
  assert.equal(
    (await getStatus(missing)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT,
  );

  const inconsistent = makeScenario();
  await confirm(inconsistent);
  inconsistent.collections.transactions.get(
    buildQrTransactionId(inconsistent.paymentReference),
  ).amountMinor = 1;
  assert.equal(
    (await getStatus(inconsistent)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT,
  );
});

test('returns minimal pending, processing, failed, and stored-expired statuses', async () => {
  const statuses = [
    PAYMENT_INTENT_STATUS.PENDING,
    PAYMENT_INTENT_STATUS.PROCESSING,
    PAYMENT_INTENT_STATUS.FAILED,
    PAYMENT_INTENT_STATUS.EXPIRED,
  ];

  for (const status of statuses) {
    const scenario = makeScenario();
    scenario.collections.paymentIntents.get(
      scenario.paymentReference,
    ).status = status;

    const result = await getStatus(scenario);

    assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.FOUND);
    assert.deepEqual(result.payment, {
      paymentReference: scenario.paymentReference,
      status,
    });
    assert.deepEqual(scenario.writesRecorded, []);
  }
});

test('derives expired status from backend time without updating Firestore', async () => {
  const scenario = makeScenario();
  const intent = scenario.collections.paymentIntents.get(
    scenario.paymentReference,
  );
  intent.expiresAt = NOW;

  const result = await getStatus(scenario);

  assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.FOUND);
  assert.deepEqual(result.payment, {
    paymentReference: scenario.paymentReference,
    status: PAYMENT_INTENT_STATUS.EXPIRED,
  });
  assert.equal(intent.status, PAYMENT_INTENT_STATUS.PENDING);
  assert.deepEqual(scenario.writesRecorded, []);
});

test('status lookup rejects unknown and malformed references without writes', async () => {
  const unknown = makeScenario();
  unknown.collections.paymentIntents.clear();
  assert.equal(
    (await getStatus(unknown)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND,
  );

  const malformed = makeScenario();
  const result = await malformed.service.getPaymentStatus({
    uid: 'customer1',
    paymentReference: 'invalid/reference',
  });
  assert.equal(
    result.outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND,
  );
  assert.deepEqual(malformed.writesRecorded, []);
});

test('status lookup rejects merchants and inactive incomplete customers', async () => {
  const merchant = makeScenario();
  assert.equal(
    (await getStatus(merchant, 'merchant1')).outcome,
    PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY,
  );

  const inactive = makeScenario();
  inactive.collections.users.get('customer1').status = 'DISABLED';
  assert.equal(
    (await getStatus(inactive)).outcome,
    PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY,
  );
});

test('inactive customer can recover only their own successful payment', async () => {
  const scenario = makeScenario();
  await confirm(scenario);
  scenario.collections.users.get('customer1').status = 'DISABLED';

  const result = await getStatus(scenario);

  assert.equal(result.outcome, PAYMENT_INTENT_OUTCOMES.FOUND);
  assert.equal(result.payment.status, PAYMENT_INTENT_STATUS.SUCCESS);
  assert.equal(result.payment.paymentReference, scenario.paymentReference);
});

test('incomplete intent with an unexpected transaction record conflicts', async () => {
  const scenario = makeScenario();
  scenario.collections.transactions.set(
    buildQrTransactionId(scenario.paymentReference),
    {
      type: 'QR_PAYMENT',
      paymentReference: scenario.paymentReference,
      customerUid: 'customer1',
      merchantUid: 'merchant1',
      amountMinor: 12550,
      currency: 'LKR',
      status: PAYMENT_INTENT_STATUS.SUCCESS,
      createdAt: NOW,
    },
  );

  const result = await getStatus(scenario);

  assert.equal(
    result.outcome,
    PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT,
  );
  assert.deepEqual(scenario.writesRecorded, []);
});
