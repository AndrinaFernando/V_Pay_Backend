const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createNotificationService } = require('../../../src/modules/notifications/notification.service');

// Stub only the Firebase boundary; exercise the real authentication middleware.
const firebasePath = require.resolve('../../../src/config/firebase');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { auth: { verifyIdToken: async (token) => {
    if (token !== 'valid-id-token') throw new Error('invalid test identity');
    return { uid: 'owner', email_verified: true };
  } } },
};
const { createNotificationRouter } = require('../../../src/modules/notifications/notification.routes');

function fixture() {
  const records = new Map([
    ['owner', { fcmToken: 'fake-device-token', name: 'Owner', role: 'CUSTOMER' }],
    ['other', { fcmToken: 'other-device-token', role: 'MERCHANT' }],
  ]);
  const sent = [];
  const db = { collection(name) {
    assert.equal(name, 'users');
    return { doc(uid) { return {
      get: async () => ({ exists: records.has(uid), data: () => records.get(uid) }),
      update: async (fields) => {
        if (!records.has(uid)) throw Object.assign(new Error('missing'), { code: 5 });
        assert.deepEqual(Object.keys(fields), ['fcmToken']);
        records.set(uid, { ...records.get(uid), ...fields });
      },
    }; } };
  } };
  const messaging = { send: async (message) => { sent.push(message); return 'fake-message-id'; } };
  return { records, sent, db, messaging, service: createNotificationService({ db, messaging }) };
}

for (const [fn, uid, type] of [
  ['notifyTopUpSuccess', 'owner', 'TOP_UP_SUCCESS'],
  ['notifyPaymentSuccess', 'owner', 'PAYMENT_SUCCESS'],
  ['notifyPaymentReceived', 'other', 'PAYMENT_RECEIVED'],
]) {
  test(`successful ${type} uses recipient profile and generic payload`, async () => {
    const f = fixture();
    assert.deepEqual(await f.service[fn](uid), { status: 'SENT' });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].token, f.records.get(uid).fcmToken);
    assert.deepEqual(f.sent[0].data, { type });
    assert.deepEqual(Object.keys(f.sent[0]).sort(), ['data', 'notification', 'token']);
    assert.deepEqual(Object.keys(f.sent[0].notification).sort(), ['body', 'title']);
  });
}

test('missing token is skipped without messaging', async () => {
  const f = fixture();
  f.records.get('owner').fcmToken = null;
  assert.deepEqual(await f.service.notifyTopUpSuccess('owner'), { status: 'MISSING_TOKEN' });
  assert.equal(f.sent.length, 0);
});

test('missing recipient profile is skipped', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.notifyPaymentSuccess('missing'), { status: 'PROFILE_NOT_FOUND' });
  assert.equal(f.sent.length, 0);
});

test('invalid notification inputs never send', async () => {
  const f = fixture();
  for (const input of [undefined, null, {}, { uid: 'owner', type: 'toString' },
    { uid: '../other', type: 'TOP_UP_SUCCESS' }, { uid: '', type: 'PAYMENT_SUCCESS' }]) {
    assert.deepEqual(await f.service.sendNotification(input), { status: 'INVALID_INPUT' });
  }
  assert.equal(f.sent.length, 0);
});

test('invalid stored token never sends', async () => {
  const f = fixture();
  f.records.get('owner').fcmToken = { invalid: true };
  assert.deepEqual(await f.service.notifyPaymentSuccess('owner'), { status: 'INVALID_TOKEN' });
  assert.equal(f.sent.length, 0);
});

test('messaging failures return safe results and do not write profiles', async () => {
  const f = fixture();
  const before = JSON.stringify([...f.records]);
  f.messaging.send = async () => { throw new Error('private token detail'); };
  assert.deepEqual(await f.service.notifyPaymentSuccess('owner'), { status: 'MESSAGING_FAILED' });
  assert.equal(JSON.stringify([...f.records]), before);
});

test('profile lookup failure is contained', async () => {
  const service = createNotificationService({ db: { collection() { throw new Error('private'); } }, messaging: {} });
  assert.deepEqual(await service.notifyPaymentReceived('owner'), { status: 'PROFILE_READ_FAILED' });
});

async function endpoint(t, f = fixture()) {
  const app = express();
  app.use(express.json());
  app.use('/api', createNotificationRouter({ getService: () => f.service }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { ...f, request: async (body, authorization = 'Bearer valid-id-token') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization && { Authorization: authorization }) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } };
}

test('authenticated token registration updates only token and does not echo it', async t => {
  const f = await endpoint(t);
  const response = await f.request({ fcmToken: 'replacement-token' });
  assert.deepEqual(response, { status: 200, body: { success: true, message: 'FCM token registered' } });
  assert.deepEqual(f.records.get('owner'), { fcmToken: 'replacement-token', name: 'Owner', role: 'CUSTOMER' });
  assert.equal(f.sent.length, 0);
});

test('unauthorized registration cannot write', async t => {
  const f = await endpoint(t);
  for (const auth of [null, 'Bearer invalid-id-token']) {
    assert.equal((await f.request({ fcmToken: 'replacement' }, auth)).status, 401);
  }
  assert.equal(f.records.get('owner').fcmToken, 'fake-device-token');
});

test('invalid token submissions are rejected', async t => {
  const f = await endpoint(t);
  for (const fcmToken of [undefined, null, '', ' has spaces ', 'line\nbreak', 12, {}, 'x'.repeat(4097)]) {
    assert.equal((await f.request({ fcmToken })).status, 400);
  }
  assert.equal(f.records.get('owner').fcmToken, 'fake-device-token');
});

test('missing user profile returns 404 without creating it', async t => {
  const f = await endpoint(t);
  f.records.delete('owner');
  assert.equal((await f.request({ fcmToken: 'replacement' })).status, 404);
  assert.equal(f.records.has('owner'), false);
});

test('client UID cannot update another user', async t => {
  const f = await endpoint(t);
  assert.equal((await f.request({ uid: 'other', fcmToken: 'replacement' })).status, 200);
  assert.equal(f.records.get('owner').fcmToken, 'replacement');
  assert.equal(f.records.get('other').fcmToken, 'other-device-token');
});

test('registration storage errors return a safe 500', async t => {
  const f = fixture();
  f.db.collection = () => { throw new Error('private token detail'); };
  const api = await endpoint(t, f);
  assert.deepEqual(await api.request({ fcmToken: 'replacement' }), {
    status: 500, body: { success: false, message: 'Unable to register FCM token' },
  });
});
