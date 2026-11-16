const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createNotificationService } = require('../../../src/modules/notifications/notification.service');

const options = {
  skip: !process.env.FIRESTORE_EMULATOR_HOST && 'Requires local Firestore Emulator at 127.0.0.1:8188',
};

async function fixture(t) {
  // Guard before initializing anything. No application config, real credentials,
  // production project, broad collection deletion, or actual FCM sends.
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8188');
  const id = randomUUID();
  const app = initializeApp({ projectId: 'demo-vpay-notifications' }, `notifications-${id}`);
  const db = getFirestore(app);
  const uids = [`a-${id}`, `b-${id}`];
  const tokens = [`shared-${id}`, `first-${id}`, `second-${id}`];
  const users = uids.map(uid => db.collection('users').doc(uid));
  const owners = tokens.map(token => db.collection('fcmTokenOwners').doc(createHash('sha256').update(token).digest('hex')));
  t.after(async () => {
    try {
      const batch = db.batch();
      [...users, ...owners].forEach(ref => batch.delete(ref));
      await batch.commit();
    } finally {
      await db.terminate();
      await deleteApp(app);
    }
  });
  await Promise.all(users.map(ref => ref.set({ fcmToken: null, name: 'Unchanged', role: 'CUSTOMER' })));
  const service = createNotificationService({ db, messaging: { send: async () => assert.fail('registration must not send FCM') } });
  return { uids, tokens, users, owners, service };
}

test('emulator: competing accounts retain exactly one token owner and matching profile', options, async t => {
  const f = await fixture(t);
  // Repeat contention on the same ownership document across independent requests.
  for (let attempt = 0; attempt < 5; attempt++) {
    const results = await Promise.all(f.uids.map(uid => f.service.registerToken({ uid, fcmToken: f.tokens[0] })));
    assert.ok(results.every(result => result.status === 'REGISTERED'));
    const owner = (await f.owners[0].get()).data();
    const winner = f.uids.indexOf(owner.uid);
    assert.ok(winner >= 0);
    assert.equal(owner.bindingId, results[winner].bindingId);
    assert.ok(Number.isFinite(owner.updatedAt.toMillis()));
    const profiles = await Promise.all(f.users.map(ref => ref.get()));
    assert.deepEqual(profiles.map(snapshot => snapshot.data().fcmToken),
      f.uids.map(uid => uid === owner.uid ? f.tokens[0] : null));
    profiles.forEach(snapshot => assert.equal(snapshot.data().name, 'Unchanged'));
  }
});

test('emulator: concurrent same-account replacements release the losing token', options, async t => {
  const f = await fixture(t);
  const results = await Promise.all(f.tokens.slice(1).map(fcmToken => f.service.registerToken({ uid: f.uids[0], fcmToken })));
  assert.ok(results.every(result => result.status === 'REGISTERED'));
  const token = (await f.users[0].get()).data().fcmToken;
  assert.ok(f.tokens.slice(1).includes(token));
  const owners = await Promise.all(f.owners.slice(1).map(ref => ref.get()));
  assert.equal(owners.filter(snapshot => snapshot.exists).length, 1);
  assert.equal(owners[f.tokens.indexOf(token) - 1].data().uid, f.uids[0]);
});

test('emulator: an old logout racing registration cannot remove the new binding', options, async t => {
  const f = await fixture(t);
  for (const nextUid of f.uids) {
    const input = { uid: f.uids[0], fcmToken: f.tokens[0] };
    const previous = await f.service.registerToken(input);
    assert.equal(previous.status, 'REGISTERED');
    const [current, removed] = await Promise.all([
      f.service.registerToken({ ...input, uid: nextUid }),
      f.service.unregisterToken({ ...input, bindingId: previous.bindingId }),
    ]);
    assert.equal(current.status, 'REGISTERED');
    assert.equal(removed.status, 'UNREGISTERED');
    const owner = (await f.owners[0].get()).data();
    assert.equal(owner.uid, nextUid);
    assert.equal(owner.bindingId, current.bindingId);
    assert.equal((await f.users[f.uids.indexOf(nextUid)].get()).data().fcmToken, f.tokens[0]);
  }
});
