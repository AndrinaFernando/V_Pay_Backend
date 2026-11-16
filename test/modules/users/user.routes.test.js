const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const profiles = new Map();
const writes = [];
const firebaseConfigPath = require.resolve('../../../src/config/firebase');
require.cache[firebaseConfigPath] = {
  id: firebaseConfigPath,
  filename: firebaseConfigPath,
  loaded: true,
  exports: {
    auth: {
      async verifyIdToken(token) {
        if (token === 'invalid') throw new Error('invalid token');
        return {
          uid: token === 'merchant' ? 'merchant-uid' : 'customer-uid',
          email: 'verified@example.test',
          email_verified: token !== 'unverified',
        };
      },
    },
    db: {
      collection(name) {
        assert.equal(name, 'users');
        return { doc: (id) => ({ id }) };
      },
      async runTransaction(callback) {
        const pending = [];
        const result = await callback({
          async get(ref) {
            const data = profiles.get(ref.id);
            return { id: ref.id, exists: Boolean(data), data: () => ({ ...data }) };
          },
          update(ref, fields) {
            pending.push({ id: ref.id, fields });
          },
        });
        for (const { id, fields } of pending) {
          assert.ok(profiles.has(id), 'update must not create a profile');
          profiles.set(id, { ...profiles.get(id), ...fields });
          writes.push({ id, fields });
        }
        return result;
      },
    },
  },
};

const routes = require('../../../src/modules/users/user.routes');
const app = express();
app.use(express.json());
app.use('/api', routes);

function resetProfiles() {
  profiles.clear();
  writes.length = 0;
  profiles.set('customer-uid', {
    name: 'Customer Name', phone: '+94771234567', email: 'customer@example.test',
    role: 'CUSTOMER', status: 'ACTIVE', createdAt: 'original-time', balance: 55,
  });
  profiles.set('merchant-uid', {
    name: 'Merchant Name', phone: '+94771234567', email: 'merchant@example.test',
    role: 'MERCHANT', status: 'ACTIVE', createdAt: 'original-time',
    businessName: 'Original Store', businessCategory: 'Retail',
    businessAddress: 'Original Address', merchantBalance: 75,
  });
}

async function patch(base, token, body) {
  const response = await fetch(`${base}/api/me`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('PATCH /api/me validates and updates only the authenticated profile', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const validUpdates = [
      ['customer name', 'customer', { name: '  New Customer  ' }, { name: 'New Customer' }],
      ['customer phone', 'customer', { phone: '077 555-1234' }, { phone: '+94775551234' }],
      ['merchant name', 'merchant', { name: '  New Merchant  ' }, { name: 'New Merchant' }],
      ['merchant phone', 'merchant', { phone: '0775551234' }, { phone: '+94775551234' }],
      ['business name', 'merchant', { businessName: '  New Store  ' }, { businessName: 'New Store' }],
      ['business category', 'merchant', { businessCategory: 'Services' }, { businessCategory: 'Services' }],
      ['business address', 'merchant', { businessAddress: '  New Address  ' }, { businessAddress: 'New Address' }],
    ];

    for (const [label, token, input, expected] of validUpdates) {
      await t.test(label, async () => {
        resetProfiles();
        const id = `${token}-uid`;
        const before = { ...profiles.get(id) };
        const result = await patch(base, token, input);
        assert.equal(result.status, 200);
        assert.equal(result.body.success, true);
        assert.equal(result.body.message, 'Profile updated successfully');
        assert.deepEqual(profiles.get(id), { ...before, ...expected });
        assert.deepEqual(result.body.data.user, { ...before, ...expected, uid: id });
        assert.deepEqual(writes, [{ id, fields: expected }]);
      });
    }

    const invalidUpdates = [
      ['empty update', 'customer', {}],
      ['short name', 'customer', { name: ' A ' }],
      ['long name', 'customer', { name: 'A'.repeat(81) }],
      ['invalid phone', 'customer', { phone: '12345' }],
      ['merchant field on customer', 'customer', { businessName: 'Store' }],
      ['email change', 'customer', { email: 'other@example.test' }],
      ['role change', 'customer', { role: 'MERCHANT' }],
      ['UID change', 'customer', { uid: 'merchant-uid' }],
      ['unknown field', 'customer', { unknown: 'value' }],
      ['status change', 'customer', { status: 'SUSPENDED' }],
      ['createdAt change', 'customer', { createdAt: 'new-time' }],
      ['balance change', 'customer', { balance: 999 }],
      ['FCM token change', 'customer', { fcmToken: 'unverified-token' }],
      ['invalid category', 'merchant', { businessCategory: 'Not a category' }],
      ['short business name', 'merchant', { businessName: 'X' }],
      ['long business name', 'merchant', { businessName: 'X'.repeat(101) }],
      ['short business address', 'merchant', { businessAddress: 'Abc' }],
      ['long business address', 'merchant', { businessAddress: 'X'.repeat(201) }],
      ['merchant balance change', 'merchant', { merchantBalance: 999 }],
    ];

    for (const [label, token, input] of invalidUpdates) {
      await t.test(label, async () => {
        resetProfiles();
        const before = new Map([...profiles].map(([id, data]) => [id, { ...data }]));
        const result = await patch(base, token, input);
        assert.equal(result.status, 400);
        assert.deepEqual(profiles, before);
        assert.equal(writes.length, 0);
      });
    }

    await t.test('profile editing preserves stored FCM tokens but never returns them', async () => {
      for (const token of ['customer', 'merchant']) {
        resetProfiles();
        const id = `${token}-uid`;
        profiles.get(id).fcmToken = 'private-device-token';
        const before = { ...profiles.get(id) };
        const result = await patch(base, token, { name: 'Updated Name' });
        assert.equal(result.status, 200);
        const { fcmToken, ...publicProfile } = before;
        assert.deepEqual(result.body.data.user, { ...publicProfile, name: 'Updated Name', uid: id });
        assert.equal(JSON.stringify(result.body).includes(fcmToken), false);
        assert.deepEqual(profiles.get(id), { ...before, name: 'Updated Name' });
        assert.deepEqual(writes, [{ id, fields: { name: 'Updated Name' } }]);
      }
    });

    await t.test('missing and invalid authentication', async () => {
      resetProfiles();
      assert.equal((await patch(base, null, { name: 'New Name' })).status, 401);
      assert.equal((await patch(base, 'invalid', { name: 'New Name' })).status, 401);
      assert.equal(writes.length, 0);
    });

    await t.test('unverified email', async () => {
      resetProfiles();
      assert.equal((await patch(base, 'unverified', { name: 'New Name' })).status, 403);
      assert.equal(writes.length, 0);
    });

    await t.test('missing profile', async () => {
      resetProfiles();
      profiles.delete('customer-uid');
      assert.equal((await patch(base, 'customer', { name: 'New Name' })).status, 404);
      assert.equal(profiles.has('customer-uid'), false);
      assert.equal(writes.length, 0);
    });

    await t.test('unsupported stored role', async () => {
      resetProfiles();
      profiles.get('customer-uid').role = 'ADMIN';
      assert.equal((await patch(base, 'customer', { name: 'New Name' })).status, 403);
      assert.equal(writes.length, 0);
    });

    await t.test('cannot edit another account', async () => {
      resetProfiles();
      const merchantBefore = { ...profiles.get('merchant-uid') };
      const result = await patch(base, 'customer', { uid: 'merchant-uid', name: 'Intruder' });
      assert.equal(result.status, 400);
      assert.deepEqual(profiles.get('merchant-uid'), merchantBefore);
      assert.equal(writes.length, 0);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
