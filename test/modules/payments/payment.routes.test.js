const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const firebaseConfigPath = require.resolve('../../../src/config/firebase');
let verifyIdToken = async () => ({
  uid: 'customer1',
  email: 'customer@example.test',
  email_verified: true,
});

const firebaseConfigStub = new Module(firebaseConfigPath);
firebaseConfigStub.filename = firebaseConfigPath;
firebaseConfigStub.loaded = true;
firebaseConfigStub.exports = {
  auth: {
    verifyIdToken: (...args) => verifyIdToken(...args),
  },
};
require.cache[firebaseConfigPath] = firebaseConfigStub;

const paymentServicePath = require.resolve('../../../src/modules/payments/payment.service');
let createPaymentIntent = async () => ({
  outcome: 'CREATED',
  paymentIntent: { paymentReference: 'created-reference' },
});
let getPaymentIntent = async () => ({
  outcome: 'FOUND',
  paymentIntent: { paymentReference: 'merchant-reference' },
});
let previewPaymentIntent = async () => ({
  outcome: 'FOUND',
  paymentIntent: { paymentReference: 'preview-reference' },
});

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

const router = require('../../../src/modules/payments/payment.routes');

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

function findRoute(path, method) {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === path && candidate.route.methods[method],
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} route must exist`);
  return layer.route.stack.map(({ handle }) => handle);
}

async function invokeRoute(path, method, req) {
  const handlers = findRoute(path, method);
  const res = makeResponse();
  let controllerPromise;

  await handlers[0](req, res, () => {
    controllerPromise = handlers[1](req, res);
  });
  if (controllerPromise) await controllerPromise;

  return res;
}

test('preview route rejects missing and invalid Firebase authentication', async () => {
  let previewCalled = false;
  previewPaymentIntent = async () => {
    previewCalled = true;
  };

  const missing = await invokeRoute(
    '/payment-intents/:paymentReference/preview',
    'get',
    {
      headers: {},
      params: { paymentReference: 'preview-reference' },
    },
  );
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.success, false);

  verifyIdToken = async () => {
    throw new Error('invalid token');
  };
  const invalid = await invokeRoute(
    '/payment-intents/:paymentReference/preview',
    'get',
    {
      headers: { authorization: 'Bearer invalid-token' },
      params: { paymentReference: 'preview-reference' },
    },
  );
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.body.success, false);
  assert.equal(previewCalled, false);
});

test('preview route authenticates and returns the expected response envelope', async () => {
  verifyIdToken = async (token) => {
    assert.equal(token, 'valid-customer-token');
    return {
      uid: 'customer1',
      email: 'customer@example.test',
      email_verified: true,
    };
  };
  previewPaymentIntent = async ({ uid, paymentReference }) => {
    assert.equal(uid, 'customer1');
    assert.equal(paymentReference, 'preview-reference');
    return {
      outcome: 'FOUND',
      paymentIntent: {
        paymentReference,
        merchantName: 'Test Merchant',
        amountMinor: 125000,
        currency: 'LKR',
        status: 'PENDING',
        createdAt: '2026-11-13T10:00:00.000Z',
        expiresAt: '2026-11-13T10:15:00.000Z',
      },
    };
  };

  const res = await invokeRoute(
    '/payment-intents/:paymentReference/preview',
    'get',
    {
      headers: { authorization: 'Bearer valid-customer-token' },
      params: { paymentReference: 'preview-reference' },
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.paymentIntent.paymentReference, 'preview-reference');
});

test('original merchant create and lookup routes remain operational', async () => {
  verifyIdToken = async () => ({
    uid: 'merchant1',
    email: 'merchant@example.test',
    email_verified: true,
  });
  createPaymentIntent = async ({ uid, amountMinor, currency }) => {
    assert.equal(uid, 'merchant1');
    assert.equal(amountMinor, 125000);
    assert.equal(currency, 'LKR');
    return {
      outcome: 'CREATED',
      paymentIntent: { paymentReference: 'created-reference' },
    };
  };
  getPaymentIntent = async ({ uid, paymentReference }) => {
    assert.equal(uid, 'merchant1');
    assert.equal(paymentReference, 'merchant-reference');
    return {
      outcome: 'FOUND',
      paymentIntent: { paymentReference },
    };
  };

  const headers = { authorization: 'Bearer valid-merchant-token' };
  const created = await invokeRoute('/payment-intents', 'post', {
    headers,
    body: { amountMinor: 125000, currency: 'LKR' },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.data.paymentIntent.paymentReference, 'created-reference');

  const found = await invokeRoute(
    '/payment-intents/:paymentReference',
    'get',
    {
      headers,
      params: { paymentReference: 'merchant-reference' },
    },
  );
  assert.equal(found.statusCode, 200);
  assert.equal(found.body.data.paymentIntent.paymentReference, 'merchant-reference');
});
