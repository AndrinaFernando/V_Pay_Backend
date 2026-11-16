const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createHash, randomUUID } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { createNotificationService } = require('../../../src/modules/notifications/notification.service');

// Stub only the Firebase boundary; exercise the real authentication middleware.
const firebasePath = require.resolve('../../../src/config/firebase');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { auth: { verifyIdToken: async (token) => {
    if (!['valid-id-token', 'other-id-token'].includes(token)) throw new Error('invalid test identity');
    return { uid: token === 'valid-id-token' ? 'owner' : 'other', email_verified: true };
  } } },
};
const { createNotificationRouter } = require('../../../src/modules/notifications/notification.routes');

const tokenHash = token => createHash('sha256').update(token).digest('hex');
const bindingPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixture() {
  const records = new Map([
    ['owner', { fcmToken: 'fake-device-token', name: 'Owner', role: 'CUSTOMER' }],
    ['other', { fcmToken: 'other-device-token', role: 'MERCHANT' }],
  ]);
  const owners = new Map([...records].map(([uid, user]) => [tokenHash(user.fcmToken), {
    uid, bindingId: randomUUID(), updatedAt: FieldValue.serverTimestamp(),
  }]));
  const sent = [];
  let queue = Promise.resolve();
  let inTransaction = false;
  // This fake serializes callbacks and stages writes. It checks service behavior
  // and read-before-write ordering, NOT actual Firestore contention/atomicity.
  const db = { collection(name) {
    assert.ok(['users', 'fcmTokenOwners'].includes(name), 'must not access financial collections');
    return { doc(id) { return { name, id }; } };
  }, runTransaction(callback) {
    const attempt = queue.then(async () => {
      const writes = [];
      const store = ref => ref.name === 'users' ? records : owners;
      inTransaction = true;
      try {
        const result = await callback({
          get: async ref => {
            assert.equal(writes.length, 0, 'all reads must precede writes');
            const data = store(ref).get(ref.id);
            return { exists: data !== undefined, data: () => data && { ...data } };
          },
          update: (ref, fields) => {
            assert.equal(ref.name, 'users');
            assert.deepEqual(Object.keys(fields), ['fcmToken']);
            assert.ok(store(ref).has(ref.id), 'update cannot create profiles');
            writes.push(() => store(ref).set(ref.id, { ...store(ref).get(ref.id), ...fields }));
          },
          set: (ref, fields) => {
            assert.equal(ref.name, 'fcmTokenOwners');
            assert.match(ref.id, /^[0-9a-f]{64}$/);
            assert.deepEqual(Object.keys(fields).sort(), ['bindingId', 'uid', 'updatedAt']);
            assert.deepEqual(fields.updatedAt, FieldValue.serverTimestamp());
            writes.push(() => store(ref).set(ref.id, { ...fields }));
          },
          delete: ref => {
            assert.equal(ref.name, 'fcmTokenOwners');
            writes.push(() => store(ref).delete(ref.id));
          },
        });
        if (db.failCommit) throw new Error('private commit failure');
        writes.forEach(write => write());
        return result;
      } finally { inTransaction = false; }
    });
    queue = attempt.catch(() => {});
    return attempt;
  } };
  const messaging = { send: async message => {
    assert.equal(inTransaction, false, 'FCM must run outside transactions');
    sent.push(message);
    return 'fake-message-id';
  } };
  return { records, owners, sent, db, messaging, service: createNotificationService({ db, messaging }) };
}

for (const [fn, uid, type] of [
  ['notifyTopUpSuccess', 'owner', 'TOP_UP_SUCCESS'],
  ['notifyPaymentSuccess', 'owner', 'PAYMENT_SUCCESS'],
  ['notifyPaymentReceived', 'other', 'PAYMENT_RECEIVED'],
]) {
  test(`successful ${type} uses verified ownership and data-only payload`, async () => {
    const f = fixture();
    assert.deepEqual(await f.service[fn](uid), { status: 'SENT' });
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].token, f.records.get(uid).fcmToken);
    assert.deepEqual(f.sent[0].data, { type, bindingId: f.owners.get(tokenHash(f.sent[0].token)).bindingId });
    assert.deepEqual(Object.keys(f.sent[0]).sort(), ['data', 'token']);
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
  return { ...f, request: async (body, authorization = 'Bearer valid-id-token', method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/notifications/token`, {
      method, headers: { 'Content-Type': 'application/json', ...(authorization && { Authorization: authorization }) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } };
}

test('authenticated token registration updates only token and does not echo it', async t => {
  const f = await endpoint(t);
  const response = await f.request({ fcmToken: 'replacement-token' });
  const bindingId = f.owners.get(tokenHash('replacement-token')).bindingId;
  assert.match(bindingId, bindingPattern);
  assert.deepEqual(response, { status: 200, body: { success: true, message: 'FCM token registered', data: { bindingId } } });
  assert.deepEqual(f.records.get('owner'), { fcmToken: 'replacement-token', name: 'Owner', role: 'CUSTOMER' });
  assert.equal(f.sent.length, 0);
});

test('first registration creates ownership without creating or changing other profile fields', async () => {
  const f = fixture();
  f.records.set('new', { fcmToken: null, name: 'New', status: 'ACTIVE' });
  const result = await f.service.registerToken({ uid: 'new', fcmToken: 'new-token' });
  assert.equal(result.status, 'REGISTERED');
  assert.match(result.bindingId, bindingPattern);
  assert.equal(f.owners.get(tokenHash('new-token')).uid, 'new');
  assert.deepEqual(f.records.get('new'), { fcmToken: 'new-token', name: 'New', status: 'ACTIVE' });
});

test('repeated registration rotates binding and an old logout cannot delete it', async () => {
  const f = fixture();
  const input = { uid: 'owner', fcmToken: 'fake-device-token' };
  const first = await f.service.registerToken(input);
  const second = await f.service.registerToken(input);
  assert.notEqual(first.bindingId, second.bindingId);
  assert.deepEqual(await f.service.unregisterToken({ ...input, bindingId: first.bindingId }), { status: 'UNREGISTERED' });
  assert.equal(f.owners.get(tokenHash(input.fcmToken)).bindingId, second.bindingId);
  assert.equal(f.records.get(input.uid).fcmToken, input.fcmToken);
});

test('token replacement removes only the previous ownership belonging to the caller', async () => {
  const f = fixture();
  await f.service.registerToken({ uid: 'owner', fcmToken: 'replacement' });
  assert.equal(f.owners.has(tokenHash('fake-device-token')), false);
  // A stale profile pointer must not delete another user's authoritative binding.
  f.records.get('owner').fcmToken = 'other-device-token';
  const otherBinding = f.owners.get(tokenHash('other-device-token'));
  await f.service.registerToken({ uid: 'owner', fcmToken: 'replacement-2' });
  assert.deepEqual(f.owners.get(tokenHash('other-device-token')), otherBinding);
});

test('account transfer clears the previous owner and releases the new owner previous token', async () => {
  const f = fixture();
  const oldBinding = f.owners.get(tokenHash('fake-device-token')).bindingId;
  const result = await f.service.registerToken({ uid: 'other', fcmToken: 'fake-device-token' });
  assert.equal(result.status, 'REGISTERED');
  assert.deepEqual(f.records.get('owner'), { fcmToken: null, name: 'Owner', role: 'CUSTOMER' });
  assert.deepEqual(f.records.get('other'), { fcmToken: 'fake-device-token', role: 'MERCHANT' });
  assert.equal(f.owners.has(tokenHash('other-device-token')), false);
  assert.equal(f.owners.get(tokenHash('fake-device-token')).uid, 'other');
  await f.service.unregisterToken({ uid: 'owner', fcmToken: 'fake-device-token', bindingId: oldBinding });
  assert.equal(f.owners.get(tokenHash('fake-device-token')).bindingId, result.bindingId);
});

test('transfer tolerates a missing former profile and preserves a changed former token', async () => {
  for (const missing of [true, false]) {
    const f = fixture();
    if (missing) f.records.delete('owner');
    else f.records.get('owner').fcmToken = 'another-token';
    assert.equal((await f.service.registerToken({ uid: 'other', fcmToken: 'fake-device-token' })).status, 'REGISTERED');
    assert.equal(f.records.get('owner')?.fcmToken, missing ? undefined : 'another-token');
  }
});

test('safe removal is repeatable and preserves profile fields', async t => {
  const f = await endpoint(t);
  const body = { fcmToken: 'fake-device-token', bindingId: f.owners.get(tokenHash('fake-device-token')).bindingId };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await f.request(body, undefined, 'DELETE'), {
      status: 200, body: { success: true, message: 'FCM token unregistered' },
    });
  }
  assert.equal(f.owners.has(tokenHash(body.fcmToken)), false);
  assert.deepEqual(f.records.get('owner'), { fcmToken: null, name: 'Owner', role: 'CUSTOMER' });
});

test('foreign and absent bindings return identical no-op responses without trusting body UID', async t => {
  const f = await endpoint(t);
  const before = JSON.stringify([...f.records, ...f.owners]);
  const bindingId = f.owners.get(tokenHash('other-device-token')).bindingId;
  const foreign = await f.request({ uid: 'other', fcmToken: 'other-device-token', bindingId }, undefined, 'DELETE');
  const absent = await f.request({ fcmToken: 'absent-token', bindingId }, undefined, 'DELETE');
  assert.equal(foreign.status, 200);
  assert.deepEqual(foreign, absent);
  assert.equal(JSON.stringify([...f.records, ...f.owners]), before);
});

test('unauthorized deletion cannot change ownership', async t => {
  const f = await endpoint(t);
  const body = { fcmToken: 'fake-device-token', bindingId: f.owners.get(tokenHash('fake-device-token')).bindingId };
  for (const auth of [null, 'Bearer invalid-id-token']) {
    assert.equal((await f.request(body, auth, 'DELETE')).status, 401);
  }
  assert.equal(f.records.get('owner').fcmToken, body.fcmToken);
  assert.equal(f.owners.get(tokenHash(body.fcmToken)).bindingId, body.bindingId);
});

test('invalid binding IDs and invalid deletion tokens are rejected', async t => {
  const f = await endpoint(t);
  for (const bindingId of [undefined, null, '', 'not-a-uuid', {}, 12, 'a'.repeat(4097), `${randomUUID()}\n`]) {
    assert.equal((await f.request({ fcmToken: 'fake-device-token', bindingId }, undefined, 'DELETE')).status, 400);
  }
  for (const fcmToken of [undefined, null, '', 'has spaces', 'token\n', 'token\r\n', {}, 12]) {
    assert.equal((await f.request({ fcmToken, bindingId: randomUUID() }, undefined, 'DELETE')).status, 400);
  }
  assert.equal(f.owners.size, 2);
});

test('matching removal tolerates missing profile and does not clear a replacement token', async () => {
  for (const missing of [true, false]) {
    const f = fixture();
    const bindingId = f.owners.get(tokenHash('fake-device-token')).bindingId;
    if (missing) f.records.delete('owner');
    else f.records.get('owner').fcmToken = 'replacement';
    assert.equal((await f.service.unregisterToken({ uid: 'owner', fcmToken: 'fake-device-token', bindingId })).status, 'UNREGISTERED');
    assert.equal(f.owners.has(tokenHash('fake-device-token')), false);
    assert.equal(f.records.get('owner')?.fcmToken, missing ? undefined : 'replacement');
  }
});

test('overlapping claims in the serialized fake leave only the last owner', async () => {
  const f = fixture();
  const results = await Promise.all(['owner', 'other'].map(uid => f.service.registerToken({ uid, fcmToken: 'shared-token' })));
  assert.ok(results.every(result => result.status === 'REGISTERED'));
  assert.equal(f.records.get('owner').fcmToken, null);
  assert.equal(f.records.get('other').fcmToken, 'shared-token');
  assert.equal(f.owners.get(tokenHash('shared-token')).uid, 'other');
  assert.equal(f.owners.size, 1);
});

test('overlapping same-user replacements in the fake leave only the final token', async () => {
  const f = fixture();
  await Promise.all(['first-token', 'second-token'].map(fcmToken => f.service.registerToken({ uid: 'owner', fcmToken })));
  assert.equal(f.records.get('owner').fcmToken, 'second-token');
  assert.equal(f.owners.has(tokenHash('first-token')), false);
  assert.equal(f.owners.has(tokenHash('fake-device-token')), false);
});

test('sender rejects legacy, mismatched, and invalid bindings without FCM', async () => {
  for (const owner of [undefined, { uid: 'other', bindingId: randomUUID() }, { uid: 'owner', bindingId: 'invalid' }]) {
    const f = fixture();
    if (owner) f.owners.set(tokenHash('fake-device-token'), owner);
    else f.owners.delete(tokenHash('fake-device-token'));
    assert.deepEqual(await f.service.notifyPaymentSuccess('owner'), { status: 'UNVERIFIED_TOKEN' });
    assert.equal(f.sent.length, 0);
  }
});

test('failed transaction commits do not partially transfer ownership', async () => {
  const f = fixture();
  const before = JSON.stringify([...f.records, ...f.owners]);
  f.db.failCommit = true;
  assert.deepEqual(await f.service.registerToken({ uid: 'other', fcmToken: 'fake-device-token' }), { status: 'TOKEN_UPDATE_FAILED' });
  assert.equal(JSON.stringify([...f.records, ...f.owners]), before);
});

test('unregistration storage errors return sanitized 500', async t => {
  const f = fixture();
  f.db.runTransaction = async () => { throw new Error('private token detail'); };
  const api = await endpoint(t, f);
  assert.deepEqual(await api.request({ fcmToken: 'secret-token', bindingId: randomUUID() }, undefined, 'DELETE'), {
    status: 500, body: { success: false, message: 'Unable to unregister FCM token' },
  });
});

test('definitive invalid-token failures remove only the captured binding', async () => {
  for (const code of ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']) {
    const f = fixture();
    f.messaging.send = async () => { throw Object.assign(new Error('private token detail'), { code }); };
    assert.deepEqual(await f.service.notifyPaymentSuccess('owner'), { status: 'MESSAGING_FAILED' });
    assert.equal(f.records.get('owner').fcmToken, null);
    assert.equal(f.owners.has(tokenHash('fake-device-token')), false);
  }
});

test('late invalid-token failure cannot remove a renewed or transferred binding', async () => {
  for (const uid of ['owner', 'other']) {
    const f = fixture();
    let registration;
    f.messaging.send = async message => {
      registration = await f.service.registerToken({ uid, fcmToken: message.token });
      throw Object.assign(new Error('private'), { code: 'messaging/registration-token-not-registered' });
    };
    assert.deepEqual(await f.service.notifyPaymentSuccess('owner'), { status: 'MESSAGING_FAILED' });
    assert.equal(f.owners.get(tokenHash('fake-device-token')).bindingId, registration.bindingId);
    assert.equal(f.records.get(uid).fcmToken, 'fake-device-token');
  }
});

test('transient and ambiguous SDK failures preserve ownership', async () => {
  for (const code of ['messaging/server-unavailable', 'messaging/quota-exceeded', 'messaging/invalid-argument', 'messaging/mismatched-credential']) {
    const f = fixture();
    const before = JSON.stringify([...f.records, ...f.owners]);
    f.messaging.send = async () => { throw Object.assign(new Error('private'), { code }); };
    assert.deepEqual(await f.service.notifyPaymentReceived('other'), { status: 'MESSAGING_FAILED' });
    assert.equal(JSON.stringify([...f.records, ...f.owners]), before);
  }
});

test('cleanup failure stays contained and notification paths never access financial collections', async () => {
  const f = fixture();
  f.messaging.send = async () => {
    f.db.failCommit = true;
    throw Object.assign(new Error('private'), { code: 'messaging/registration-token-not-registered' });
  };
  assert.deepEqual(await f.service.notifyTopUpSuccess('owner'), { status: 'MESSAGING_FAILED' });
  assert.equal(f.records.get('owner').fcmToken, 'fake-device-token');
});

test('standalone helpers preserve signatures and contain initialization failures', async () => {
  const notification = require('../../../src/modules/notifications/notification.service');
  for (const name of ['notifyTopUpSuccess', 'notifyPaymentSuccess', 'notifyPaymentReceived']) {
    assert.deepEqual(await notification[name]('owner'), { status: 'SERVICE_UNAVAILABLE' });
  }
  assert.deepEqual(await notification.sendNotification({ uid: 'owner', type: 'PAYMENT_SUCCESS' }), { status: 'SERVICE_UNAVAILABLE' });
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
  for (const fcmToken of [undefined, null, '', ' has spaces ', 'line\nbreak', 'token\n', 'token\r\n', 12, {}, 'x'.repeat(4097)]) {
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
