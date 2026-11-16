const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const paymentServicePath = require.resolve('../../../src/modules/payments/payment.service');
let createPaymentIntent = async () => {
  throw new Error('Firestore unavailable');
};
let getPaymentIntent = async () => {
  throw new Error('Firestore unavailable');
};
let listPaymentIntents = async () => {
  throw new Error('Firestore unavailable');
};
let previewPaymentIntent = async () => {
  throw new Error('Firestore unavailable');
};
let confirmPaymentIntent = async () => {
  throw new Error('Firestore unavailable');
};
let getPaymentStatus = async () => {
  throw new Error('Firestore unavailable');
};

const paymentServiceStub = new Module(paymentServicePath);
paymentServiceStub.filename = paymentServicePath;
paymentServiceStub.loaded = true;
paymentServiceStub.exports = {
  PAYMENT_EXECUTION_OUTCOMES: {
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
  },
  PAYMENT_INTENT_OUTCOMES: {
    CREATED: 'CREATED',
    FOUND: 'FOUND',
    LISTED: 'LISTED',
    PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
    ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',
    NOT_FOUND: 'NOT_FOUND',
  },
  confirmPaymentIntent: (...args) => confirmPaymentIntent(...args),
  createPaymentIntent: (...args) => createPaymentIntent(...args),
  getPaymentIntent: (...args) => getPaymentIntent(...args),
  listPaymentIntents: (...args) => listPaymentIntents(...args),
  getPaymentStatus: (...args) => getPaymentStatus(...args),
  previewPaymentIntent: (...args) => previewPaymentIntent(...args),
};
require.cache[paymentServicePath] = paymentServiceStub;

const {
  confirmByReference,
  create,
  getByReference,
  getPaymentStatusByReference,
  list,
  previewByReference,
} = require('../../../src/modules/payments/payment.controller');

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('does not call intent creation for an unverified account', async () => {
  let called = false;
  createPaymentIntent = async () => {
    called = true;
  };
  const res = makeResponse();

  await create(
    {
      user: { uid: 'verified-uid', emailVerified: false },
      body: { amountMinor: 1000, currency: 'LKR' },
    },
    res,
  );

  assert.equal(res.statusCode, 403);
  assert.equal(called, false);
});

test('returns a safe server error when Firestore creation fails', async () => {
  createPaymentIntent = async ({ uid }) => {
    assert.equal(uid, 'verified-uid');
    throw new Error('private database detail');
  };
  const res = makeResponse();

  await create(
    {
      user: { uid: 'verified-uid', emailVerified: true },
      body: { amountMinor: 1000, currency: 'LKR' },
    },
    res,
  );

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    success: false,
    message: 'Unable to create payment intent',
  });
});

test('returns a safe server error when Firestore retrieval fails', async () => {
  getPaymentIntent = async ({ uid, paymentReference }) => {
    assert.equal(uid, 'verified-uid');
    assert.equal(paymentReference, 'intent-reference');
    throw new Error('private database detail');
  };
  const res = makeResponse();

  await getByReference(
    {
      user: { uid: 'verified-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
    },
    res,
  );

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    success: false,
    message: 'Unable to retrieve payment intent',
  });
});

test('lists only for verified users and derives merchant UID from auth middleware', async () => {
  let args;
  listPaymentIntents = async (input) => {
    args = input;
    return { outcome: 'LISTED', paymentIntents: [] };
  };
  const res = makeResponse();

  await list(
    {
      user: { uid: 'verified-uid', emailVerified: true },
      query: { limit: '7' },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(args, { uid: 'verified-uid', limit: 7 });
  assert.deepEqual(res.body, {
    success: true,
    data: { paymentIntents: [] },
  });
});

test('rejects unverified intent-list requests without calling service', async () => {
  let called = false;
  listPaymentIntents = async () => {
    called = true;
  };
  const res = makeResponse();

  await list(
    { user: { uid: 'verified-uid', emailVerified: false }, query: {} },
    res,
  );

  assert.equal(res.statusCode, 403);
  assert.equal(called, false);
});

test('returns the customer payment preview in the standard envelope', async () => {
  const paymentIntent = {
    paymentReference: 'intent-reference',
    merchantName: 'Test Merchant',
    amountMinor: 125000,
    currency: 'LKR',
    status: 'PENDING',
    createdAt: '2026-11-13T10:00:00.000Z',
    expiresAt: '2026-11-13T10:15:00.000Z',
    description: 'Order 123',
  };
  previewPaymentIntent = async ({ uid, paymentReference }) => {
    assert.equal(uid, 'customer-uid');
    assert.equal(paymentReference, 'intent-reference');
    return { outcome: 'FOUND', paymentIntent };
  };
  const res = makeResponse();

  await previewByReference(
    {
      user: { uid: 'customer-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    data: { paymentIntent },
  });
});

test('does not retrieve a preview for an unverified account', async () => {
  let called = false;
  previewPaymentIntent = async () => {
    called = true;
  };
  const res = makeResponse();

  await previewByReference(
    {
      user: { uid: 'customer-uid', emailVerified: false },
      params: { paymentReference: 'intent-reference' },
    },
    res,
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    success: false,
    message: 'Email verification is required',
  });
  assert.equal(called, false);
});

test('returns a customer-specific error for a merchant or inactive customer', async () => {
  previewPaymentIntent = async () => ({ outcome: 'ROLE_FORBIDDEN' });
  const res = makeResponse();

  await previewByReference(
    {
      user: { uid: 'non-customer-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
    },
    res,
  );

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    success: false,
    message: 'Only active customer accounts can preview payment intents',
  });
});

test('returns a distinct preview error when the customer profile is missing', async () => {
  previewPaymentIntent = async ({ uid, paymentReference }) => {
    assert.equal(uid, 'missing-customer-uid');
    assert.equal(paymentReference, 'intent-reference');
    return { outcome: 'PROFILE_NOT_FOUND' };
  };
  const res = makeResponse();

  await previewByReference(
    {
      user: { uid: 'missing-customer-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
    },
    res,
  );

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    success: false,
    code: 'CUSTOMER_PROFILE_NOT_FOUND',
    message: 'VPay user profile not found',
  });
});

test('returns safe preview errors for missing intents and service failures', async () => {
  previewPaymentIntent = async () => ({ outcome: 'NOT_FOUND' });
  const missingResponse = makeResponse();
  const request = {
    user: { uid: 'customer-uid', emailVerified: true },
    params: { paymentReference: 'unknown-reference' },
  };

  await previewByReference(request, missingResponse);
  assert.equal(missingResponse.statusCode, 404);
  assert.deepEqual(missingResponse.body, {
    success: false,
    code: 'PAYMENT_INTENT_NOT_FOUND',
    message: 'Payment intent not found',
  });

  previewPaymentIntent = async () => {
    throw new Error('private database detail');
  };
  const failedResponse = makeResponse();
  await previewByReference(request, failedResponse);
  assert.equal(failedResponse.statusCode, 500);
  assert.deepEqual(failedResponse.body, {
    success: false,
    message: 'Unable to preview payment intent',
  });
});

test('confirms a payment without accepting client-authoritative fields', async () => {
  const payment = {
    transactionId: 'qr-payment--intent-reference',
    paymentReference: 'intent-reference',
    merchantName: 'Test Merchant',
    amountMinor: 12550,
    currency: 'LKR',
    status: 'SUCCESS',
    paidAt: '2026-11-15T10:00:00.000Z',
  };
  confirmPaymentIntent = async ({ uid, paymentReference }) => {
    assert.equal(uid, 'customer-uid');
    assert.equal(paymentReference, 'intent-reference');
    return { outcome: 'SUCCEEDED', payment };
  };
  const res = makeResponse();

  await confirmByReference(
    {
      user: { uid: 'customer-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
      body: {},
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    data: { payment },
  });

  const rejected = makeResponse();
  await confirmByReference(
    {
      user: { uid: 'customer-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
      body: { amountMinor: 1 },
    },
    rejected,
  );
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.body.code, 'INVALID_REQUEST');

  const rejectedNull = makeResponse();
  await confirmByReference(
    {
      user: { uid: 'customer-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
      body: null,
    },
    rejectedNull,
  );
  assert.equal(rejectedNull.statusCode, 400);
  assert.equal(rejectedNull.body.code, 'INVALID_REQUEST');

  const rejectedLimitOverride = makeResponse();
  await confirmByReference(
    {
      user: { uid: 'customer-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
      body: { maxLimitMinor: 5_000_000 },
    },
    rejectedLimitOverride,
  );
  assert.equal(rejectedLimitOverride.statusCode, 400);
  assert.equal(rejectedLimitOverride.body.code, 'INVALID_REQUEST');
});

test('rejects unverified payment confirmation before calling the service', async () => {
  let called = false;
  confirmPaymentIntent = async () => {
    called = true;
  };
  const res = makeResponse();

  await confirmByReference(
    {
      user: { uid: 'customer-uid', emailVerified: false },
      params: { paymentReference: 'intent-reference' },
      body: {},
    },
    res,
  );

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'ACCOUNT_NOT_READY');
  assert.equal(called, false);
});

test('returns stable confirmation error codes and hides service failures', async () => {
  const request = {
    user: { uid: 'customer-uid', emailVerified: true },
    params: { paymentReference: 'intent-reference' },
    body: {},
  };
  const cases = [
    ['PAYMENT_NOT_FOUND', 404],
    ['PAYMENT_EXPIRED', 410],
    ['PAYMENT_FAILED', 409],
    ['PAYMENT_ALREADY_PAID', 409],
    ['PAYMENT_BELOW_MINIMUM', 409],
    ['PAYMENT_LIMIT_EXCEEDED', 409],
    ['INSUFFICIENT_BALANCE', 409],
    ['MINIMUM_BALANCE_REQUIRED', 409],
    ['CARD_FROZEN', 409],
    ['CARD_EXPIRED', 409],
    ['ACCOUNT_NOT_READY', 403],
    ['MERCHANT_UNAVAILABLE', 409],
    ['INVALID_BALANCE_SCHEMA', 409],
    ['PAYMENT_CONFLICT', 409],
    ['PAYMENT_UNAVAILABLE', 503],
  ];

  for (const [outcome, statusCode] of cases) {
    confirmPaymentIntent = async () => ({ outcome });
    const response = makeResponse();
    await confirmByReference(request, response);
    assert.equal(response.statusCode, statusCode);
    assert.equal(response.body.code, outcome);
    assert.equal(response.body.success, false);
  }

  confirmPaymentIntent = async () => {
    throw new Error('private Firestore detail');
  };
  const failed = makeResponse();
  await confirmByReference(request, failed);
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.body, {
    success: false,
    code: 'PAYMENT_UNAVAILABLE',
    message: 'QR payment execution is unavailable',
  });
});

test('returns payment status in the standard envelope', async () => {
  const payment = {
    paymentReference: 'intent-reference',
    status: 'PENDING',
  };
  getPaymentStatus = async ({ uid, paymentReference }) => {
    assert.equal(uid, 'customer-uid');
    assert.equal(paymentReference, 'intent-reference');
    return { outcome: 'FOUND', payment };
  };
  const res = makeResponse();

  await getPaymentStatusByReference(
    {
      user: { uid: 'customer-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    data: { payment },
  });
});

test('status lookup rejects unverified email and maps safe errors', async () => {
  let called = false;
  getPaymentStatus = async () => {
    called = true;
  };
  const unverified = makeResponse();

  await getPaymentStatusByReference(
    {
      user: { uid: 'customer-uid', emailVerified: false },
      params: { paymentReference: 'intent-reference' },
    },
    unverified,
  );
  assert.equal(unverified.statusCode, 403);
  assert.equal(unverified.body.code, 'ACCOUNT_NOT_READY');
  assert.equal(called, false);

  getPaymentStatus = async () => ({ outcome: 'PAYMENT_CONFLICT' });
  const conflict = makeResponse();
  await getPaymentStatusByReference(
    {
      user: { uid: 'customer-uid', emailVerified: true },
      params: { paymentReference: 'intent-reference' },
    },
    conflict,
  );
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, 'PAYMENT_CONFLICT');
});
