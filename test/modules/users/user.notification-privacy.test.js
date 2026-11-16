const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const profile = Object.freeze({
  uid: 'owner', name: 'Owner', email: 'owner@example.test', phone: '+94771234567',
  role: 'CUSTOMER', status: 'ACTIVE', fcmToken: 'private-device-token',
});
const card = Object.freeze({ ownerId: 'owner', balance: 100 });
let outcome = 'EXISTING';
const servicePath = require.resolve('../../../src/modules/users/user.service');
require.cache[servicePath] = {
  id: servicePath, filename: servicePath, loaded: true,
  exports: {
    BOOTSTRAP_OUTCOMES: { CREATED: 'CREATED', EXISTING: 'EXISTING', ROLE_CONFLICT: 'ROLE_CONFLICT' },
    bootstrapUser: async input => {
      assert.equal(input.uid, 'owner');
      return { outcome, user: profile, card };
    },
    getUserByUid: async uid => {
      assert.equal(uid, 'owner');
      return profile;
    },
  },
};
const firebasePath = require.resolve('../../../src/config/firebase');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { auth: { verifyIdToken: async () => ({ uid: 'owner', email_verified: true }) } },
};
const userRoutes = require('../../../src/modules/users/user.routes');

test('GET /me and both bootstrap success responses omit tokens without mutating stored profiles or card data', async t => {
  const app = express();
  app.use(express.json());
  app.use('/api', userRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const request = async (path, method, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method, headers: { Authorization: 'Bearer test-identity', 'Content-Type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const { fcmToken, ...expectedProfile } = profile;
  const me = await request('/me', 'GET');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.data.user, expectedProfile);
  for (const value of ['EXISTING', 'CREATED']) {
    outcome = value;
    const result = await request('/users/bootstrap', 'POST', {
      name: 'Owner', phone: '0771234567', role: 'CUSTOMER',
    });
    assert.equal(result.status, value === 'CREATED' ? 201 : 200);
    assert.deepEqual(result.body.data.user, expectedProfile);
    assert.deepEqual(result.body.data.card, card);
    assert.equal(JSON.stringify(result.body).includes(fcmToken), false);
  }
  assert.equal(profile.fcmToken, 'private-device-token');
  assert.equal(card.balance, 100);
});
