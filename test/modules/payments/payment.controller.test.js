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
};
require.cache[paymentServicePath] = paymentServiceStub;

const { create, getByReference } = require('../../../src/modules/payments/payment.controller');

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
