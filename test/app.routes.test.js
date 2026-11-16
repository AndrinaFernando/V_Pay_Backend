const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise the actual application router composition without Firebase credentials.
const firebasePath = require.resolve('../src/config/firebase');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    auth: { verifyIdToken: async () => assert.fail('requests intentionally have no authentication') },
    db: { collection: () => assert.fail('unauthenticated requests must not access Firestore') },
  },
};
const app = require('../src/app');

test('application preserves notification and development routes behind Firebase authentication', async t => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  for (const [method, path] of [
    ['POST', '/notifications/token'],
    ['DELETE', '/notifications/token'],
    ['GET', '/me'],
    ['PATCH', '/me'],
    ['POST', '/users/bootstrap'],
    ['GET', '/merchant/balance'],
    ['GET', '/merchant/transactions'],
    ['GET', '/customer/transactions'],
    ['POST', '/payment-intents'],
    ['GET', '/payment-intents'],
    ['GET', '/payment-intents/test-reference'],
    ['GET', '/payment-intents/test-reference/preview'],
    ['POST', '/payment-intents/test-reference/confirm'],
    ['GET', '/payment-intents/test-reference/payment-status'],
    ['POST', '/topups'],
    ['GET', '/topups'],
    ['GET', '/topups/test-topup'],
  ]) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 401, `${method} ${path} must be mounted and authenticated`);
    assert.equal((await response.json()).success, false);
  }
});
