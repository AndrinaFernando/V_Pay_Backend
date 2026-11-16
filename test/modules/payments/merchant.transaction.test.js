const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPaymentService } = require('../../../src/modules/payments/payment.service');
const { validateListMerchantTransactionsQuery } = require('../../../src/modules/payments/payment.validation');

let currentDb;
const firebasePath = require.resolve('../../../src/config/firebase');
require.cache[firebasePath] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    get db() { return currentDb; },
    auth: { verifyIdToken: async token => {
      if (token === 'invalid') throw new Error('Invalid test token');
      return { uid: token === 'unverified' ? 'merchant' : token, email_verified: token !== 'unverified' };
    } },
  },
};
const router = require('../../../src/modules/payments/payment.routes');

function fixture() {
  const collections = {
    users: new Map([
      ['merchant', { role: 'MERCHANT', status: 'ACTIVE' }],
      ['other', { role: 'MERCHANT', status: 'ACTIVE' }],
      ['customer', { role: 'CUSTOMER', status: 'ACTIVE' }],
      ['inactive', { role: 'MERCHANT', status: 'INACTIVE' }],
    ]),
    transactions: new Map(), paymentIntents: new Map(),
  };
  const queries = [];
  const reads = [];
  const writes = [];
  const rejectWrite = () => { writes.push('unexpected write'); throw new Error('No writes allowed'); };
  function add(id, overrides = {}) {
    const record = {
      paymentReference: id, customerUid: 'customer', merchantUid: 'merchant',
      type: 'QR_PAYMENT', status: 'SUCCESS', amountMinor: 12345, currency: 'LKR',
      createdAt: new Date('2026-11-16T10:00:00.000Z'), ...overrides,
    };
    collections.transactions.set(`qr-payment--${id}`, record);
    collections.paymentIntents.set(id, {
      merchantUid: record.merchantUid, customerUid: record.customerUid, merchantName: 'Test shop',
      status: record.status, amountMinor: record.amountMinor, currency: record.currency, paidAt: record.createdAt,
    });
    return record;
  }
  const db = {
    runTransaction: rejectWrite,
    collection(name) {
      assert.ok(Object.hasOwn(collections, name), 'Only profiles, transactions and intents may be read');
      const query = { collection: name, filters: [] };
      return {
        doc(id) { return {
          get: async () => {
            reads.push(`${name}/${id}`);
            return { exists: collections[name].has(id), data: () => collections[name].get(id) };
          },
          set: rejectWrite, update: rejectWrite, create: rejectWrite, delete: rejectWrite,
        }; },
        where(field, operator, value) {
          assert.equal(operator, '==');
          query.filters.push([field, value]);
          return this;
        },
        orderBy(field, direction) { query.order = [field, direction]; return this; },
        limit(value) { query.limit = value; return this; },
        async get() {
          queries.push(query);
          const toMillis = value => (value?.toDate ? value.toDate() : value).getTime();
          const docs = [...collections[name]]
            .filter(([, data]) => query.filters.every(([key, value]) => data[key] === value))
            .sort(([, a], [, b]) => {
              const comparison = toMillis(a[query.order[0]]) - toMillis(b[query.order[0]]);
              return query.order[1] === 'desc' ? -comparison : comparison;
            })
            .slice(0, query.limit)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs };
        },
      };
    },
  };
  return { db, collections, queries, reads, writes, add };
}

async function api(t, f = fixture()) {
  currentDb = f.db;
  const app = express();
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { ...f, get: async (query = '', token = 'merchant') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/merchant/transactions${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json() };
  } };
}

test('merchant HTTP history has exact fields, integer minor units, ISO date, and no writes', async t => {
  const f = await api(t);
  f.add('one');
  const before = JSON.stringify(Object.values(f.collections).map(map => [...map]));
  assert.deepEqual(await f.get(), {
    status: 200, body: { success: true, data: { transactions: [{
      transactionId: 'qr-payment--one', paymentReference: 'one', amountMinor: 12345,
      currency: 'LKR', status: 'SUCCESS', createdAt: '2026-11-16T10:00:00.000Z',
    }] } },
  });
  assert.deepEqual(f.writes, []);
  assert.equal(JSON.stringify(Object.values(f.collections).map(map => [...map])), before);
  assert.deepEqual(f.queries, [{ collection: 'transactions', filters: [
    ['merchantUid', 'merchant'], ['type', 'QR_PAYMENT'], ['status', 'SUCCESS'],
  ], order: ['createdAt', 'desc'], limit: 20 }]);
});

test('ownership comes only from verified UID, ignoring client merchant identifiers', async t => {
  const f = await api(t);
  f.add('mine');
  f.add('theirs', { merchantUid: 'other' });
  const response = await f.get('?merchantUid=other&uid=other');
  assert.deepEqual(response.body.data.transactions.map(row => row.paymentReference), ['mine']);
  assert.equal(f.reads.includes('paymentIntents/theirs'), false);
  assert.deepEqual((await f.get('', 'other')).body.data.transactions.map(row => row.paymentReference), ['theirs']);
});

for (const token of [null, 'invalid']) {
  test(`rejects unauthorized history (${token})`, async t => {
    const f = await api(t);
    assert.equal((await f.get('', token)).status, 401);
    assert.deepEqual(f.reads, []);
  });
}
for (const token of ['customer', 'inactive', 'unverified']) {
  test(`rejects ${token} merchant access`, async t => {
    const f = await api(t);
    const response = await f.get('', token);
    assert.equal(response.status, 403);
    assert.equal(response.body.success, false);
    assert.deepEqual(f.queries, []);
    if (token === 'unverified') assert.deepEqual(f.reads, []);
  });
}

test('missing merchant profile returns 404', async t => {
  const f = await api(t);
  assert.deepEqual(await f.get('', 'missing'), {
    status: 404, body: { success: false, message: 'VPay user profile not found' },
  });
  assert.deepEqual(f.queries, []);
});

test('default and boundary limits constrain newest-first results', async t => {
  const f = await api(t);
  for (let i = 0; i < 55; i++) f.add(`p${i}`, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) });
  for (const [query, count] of [['', 20], ['?limit=1', 1], ['?limit=50', 50]]) {
    const response = await f.get(query);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.transactions.length, count);
    assert.deepEqual(response.body.data.transactions.map(row => row.paymentReference),
      Array.from({ length: count }, (_, i) => `p${54 - i}`));
    assert.equal(f.queries.at(-1).limit, count);
  }
});

test('invalid HTTP limits are rejected before database access', async t => {
  const f = await api(t);
  for (const value of ['', '0', '51', '-1', '1.5', 'abc', '1e1', '9007199254740992', ' 2 ']) {
    assert.deepEqual(await f.get(`?limit=${encodeURIComponent(value)}`), {
      status: 400, body: { success: false, message: 'limit must be an integer from 1 to 50' },
    });
  }
  assert.equal((await f.get('?limit=1&limit=2')).status, 400);
  assert.deepEqual(f.reads, []);
  for (const limit of [null, [], {}, 20]) assert.ok(validateListMerchantTransactionsQuery({ limit }).error);
});

test('empty merchant history returns an empty successful list', async t => {
  const f = await api(t);
  assert.deepEqual(await f.get(), { status: 200, body: { success: true, data: { transactions: [] } } });
});

test('failed, pending and unrelated transaction types are excluded before limit', async t => {
  const f = await api(t);
  f.add('success');
  f.add('failed', { status: 'FAILED' });
  f.add('pending', { status: 'PENDING' });
  f.add('topup', { type: 'TOP_UP' });
  const response = await f.get('?limit=1');
  assert.deepEqual(response.body.data.transactions.map(row => row.paymentReference), ['success']);
  assert.deepEqual(f.reads, ['users/merchant', 'paymentIntents/success']);
});

test('Firestore timestamp serializes like customer history', async t => {
  const f = await api(t);
  f.add('timestamp', { createdAt: { toDate: () => new Date('2026-11-16T01:02:03.456Z') } });
  assert.equal((await f.get()).body.data.transactions[0].createdAt, '2026-11-16T01:02:03.456Z');
});

for (const [name, mutate] of [
  ['missing intent', f => f.collections.paymentIntents.delete('one')],
  ['other merchant intent', f => { f.collections.paymentIntents.get('one').merchantUid = 'other'; }],
  ['other customer intent', f => { f.collections.paymentIntents.get('one').customerUid = 'different'; }],
  ['pending intent', f => { f.collections.paymentIntents.get('one').status = 'PENDING'; }],
  ['mismatched amount', f => { f.collections.paymentIntents.get('one').amountMinor = 999; }],
  ['mismatched currency', f => { f.collections.paymentIntents.get('one').currency = 'USD'; }],
  ['mismatched paid date', f => { f.collections.paymentIntents.get('one').paidAt = new Date(0); }],
  ['missing paid date', f => { delete f.collections.paymentIntents.get('one').paidAt; }],
  ['invalid reference', f => { f.collections.transactions.get('qr-payment--one').paymentReference = '../invalid'; }],
  ['fractional minor amount', f => {
    f.collections.transactions.get('qr-payment--one').amountMinor = 1.5;
    f.collections.paymentIntents.get('one').amountMinor = 1.5;
  }],
]) {
  test(`inconsistent history fails the whole response: ${name}`, async t => {
    const f = await api(t);
    f.add('one'); f.add('valid'); mutate(f);
    assert.deepEqual(await f.get(), {
      status: 500, body: { success: false, message: 'Unable to retrieve merchant transactions' },
    });
    assert.deepEqual(f.writes, []);
  });
}

for (const collection of ['users', 'transactions', 'paymentIntents']) {
  test(`safe response for Firestore ${collection} failure`, async t => {
    const f = fixture(); f.add('one');
    const original = f.db.collection;
    f.db.collection = name => {
      if (name === collection) throw new Error('private database credentials');
      return original(name);
    };
    const endpoint = await api(t, f);
    assert.deepEqual(await endpoint.get(), {
      status: 500, body: { success: false, message: 'Unable to retrieve merchant transactions' },
    });
    assert.deepEqual(f.writes, []);
  });
}

test('injected service is directly reusable and defaults to 20', async () => {
  const f = fixture();
  const result = await createPaymentService({ db: f.db }).listMerchantTransactions({ uid: 'merchant' });
  assert.deepEqual(result, { outcome: 'LISTED', transactions: [] });
  assert.equal(f.queries[0].limit, 20);
});
