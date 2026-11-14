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
let previewPaymentIntent = async () => {
  throw new Error('Firestore unavailable');
};

const paymentServiceStub = new Module(paymentServicePath);
paymentServiceStub.filename = paymentServicePath;
paymentServiceStub.loaded = true;
paymentServiceStub.exports = {
  PAYMENT_INTENT_OUTCOMES: {
    CREATED: 'CREATED',
    FOUND: 'FOUND',
    PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
    ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',
    NOT_FOUND: 'NOT_FOUND',
  },
  createPaymentIntent: (...args) => createPaymentIntent(...args),
  getPaymentIntent: (...args) => getPaymentIntent(...args),
  previewPaymentIntent: (...args) => previewPaymentIntent(...args),
};
require.cache[paymentServicePath] = paymentServiceStub;

const {
  create,
  getByReference,
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
      body: { amountMinor: 100, currency: 'LKR' },
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
      body: { amountMinor: 100, currency: 'LKR' },
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
