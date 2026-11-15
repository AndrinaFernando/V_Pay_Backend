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
let listPaymentIntents = async () => ({
  outcome: 'LISTED',
  paymentIntents: [],
});
let previewPaymentIntent = async () => ({
  outcome: 'FOUND',
  paymentIntent: { paymentReference: 'preview-reference' },
});
let confirmPaymentIntent = async () => ({
  outcome: 'SUCCEEDED',
  payment: { paymentReference: 'confirmed-reference' },
});
let getPaymentStatus = async () => ({
  outcome: 'FOUND',
  payment: { paymentReference: 'status-reference', status: 'PENDING' },
});

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
  getPaymentStatus: (...args) => getPaymentStatus(...args),
  listPaymentIntents: (...args) => listPaymentIntents(...args),
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

test('preview route distinguishes missing customer and payment intent errors', async () => {
  verifyIdToken = async () => ({
    uid: 'customer1',
    email: 'customer@example.test',
    email_verified: true,
  });

  for (const expected of [
    {
      outcome: 'PROFILE_NOT_FOUND',
      code: 'CUSTOMER_PROFILE_NOT_FOUND',
      message: 'VPay user profile not found',
    },
    {
      outcome: 'NOT_FOUND',
      code: 'PAYMENT_INTENT_NOT_FOUND',
      message: 'Payment intent not found',
    },
  ]) {
    previewPaymentIntent = async () => ({ outcome: expected.outcome });

    const res = await invokeRoute(
      '/payment-intents/:paymentReference/preview',
      'get',
      {
        headers: { authorization: 'Bearer valid-customer-token' },
        params: { paymentReference: 'unknown-reference' },
      },
    );

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, {
      success: false,
      code: expected.code,
      message: expected.message,
    });
  }
});

test('confirmation route authenticates and remains distinct from merchant routes', async () => {
  verifyIdToken = async () => ({
    uid: 'customer1',
    email: 'customer@example.test',
    email_verified: true,
  });
  confirmPaymentIntent = async ({ uid, paymentReference }) => {
    assert.equal(uid, 'customer1');
    assert.equal(paymentReference, 'confirmed-reference');
    return {
      outcome: 'SUCCEEDED',
      payment: { paymentReference },
    };
  };

  const res = await invokeRoute(
    '/payment-intents/:paymentReference/confirm',
    'post',
    {
      headers: { authorization: 'Bearer valid-customer-token' },
      params: { paymentReference: 'confirmed-reference' },
      body: {},
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.payment.paymentReference, 'confirmed-reference');
});

test('payment-status route rejects missing and invalid Firebase authentication', async () => {
  let statusCalled = false;
  getPaymentStatus = async () => {
    statusCalled = true;
  };

  const missing = await invokeRoute(
    '/payment-intents/:paymentReference/payment-status',
    'get',
    {
      headers: {},
      params: { paymentReference: 'status-reference' },
    },
  );
  assert.equal(missing.statusCode, 401);

  verifyIdToken = async () => {
    throw new Error('invalid token');
  };
  const invalid = await invokeRoute(
    '/payment-intents/:paymentReference/payment-status',
    'get',
    {
      headers: { authorization: 'Bearer invalid-token' },
      params: { paymentReference: 'status-reference' },
    },
  );
  assert.equal(invalid.statusCode, 401);
  assert.equal(statusCalled, false);
});

test('payment-status route returns the service response', async () => {
  verifyIdToken = async () => ({
    uid: 'customer1',
    email: 'customer@example.test',
    email_verified: true,
  });
  getPaymentStatus = async ({ uid, paymentReference }) => {
    assert.equal(uid, 'customer1');
    assert.equal(paymentReference, 'status-reference');
    return {
      outcome: 'FOUND',
      payment: { paymentReference, status: 'PENDING' },
    };
  };

  const res = await invokeRoute(
    '/payment-intents/:paymentReference/payment-status',
    'get',
    {
      headers: { authorization: 'Bearer valid-customer-token' },
      params: { paymentReference: 'status-reference' },
    },
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data.payment, {
    paymentReference: 'status-reference',
    status: 'PENDING',
  });
});

test('original merchant create, lookup, and listing routes remain operational', async () => {
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
  listPaymentIntents = async ({ uid, limit }) => {
    assert.equal(uid, 'merchant1');
    assert.equal(limit, 7);
    return {
      outcome: 'LISTED',
      paymentIntents: [{ paymentReference: 'listed-reference' }],
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

  const listed = await invokeRoute('/payment-intents', 'get', {
    headers,
    query: { limit: '7' },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(
    listed.body.data.paymentIntents[0].paymentReference,
    'listed-reference',
  );
});
