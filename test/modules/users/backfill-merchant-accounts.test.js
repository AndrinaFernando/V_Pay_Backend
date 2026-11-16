const test = require('node:test');
const assert = require('node:assert/strict');
const {
  backfillMerchantAccounts,
  parseArgs,
} = require('../../../scripts/backfill-merchant-accounts');

function fakeDb(seed = {}) {
  const records = new Map(Object.entries(seed));
  let writes = 0;
  let failCommit = false;
  let beforeCommit = null;
  const snapshot = (ref) => ({
    exists: records.has(ref.key),
    data: () => records.get(ref.key),
  });
  const querySnapshot = (query) => {
    const docs = [...records].filter(([key, value]) =>
      key.startsWith(`${query.name}/`) &&
      (!query.field || value[query.field] === query.value),
    ).slice(0, query.max ?? Infinity).map(([key, data]) => ({
      id: key.split('/')[1], data: () => data,
    }));
    return { docs, empty: docs.length === 0 };
  };
  const db = {
    collection(name) {
      return {
        doc(id) {
          return { key: `${name}/${id}`, get: async () => snapshot({ key: `${name}/${id}` }) };
        },
        where(field, operator, value) {
          assert.equal(operator, '==');
          const query = { name, field, value };
          return {
            ...query,
            get: async () => querySnapshot(query),
            limit(max) { return { ...query, max, get: async () => querySnapshot({ ...query, max }) }; },
          };
        },
      };
    },
    async runTransaction(callback) {
      const pending = [];
      const transaction = {
        get: async (ref) => ref.key ? snapshot(ref) : querySnapshot(ref),
        create(ref, data) { pending.push({ ref, data }); },
      };
      const result = await callback(transaction);
      if (beforeCommit) { const callback = beforeCommit; beforeCommit = null; callback(); }
      if (failCommit) { failCommit = false; throw new Error('commit failed'); }
      for (const { ref, data } of pending) {
        if (records.has(ref.key)) throw new Error('already exists');
        records.set(ref.key, { ...data });
        writes += 1;
      }
      return result;
    },
  };
  return {
    db, records,
    get writes() { return writes; },
    failNextCommit() { failCommit = true; },
    beforeNextCommit(callback) { beforeCommit = callback; },
  };
}

test('dry run reports eligible, existing and review cases without writes', async () => {
  const fake = fakeDb({
    'users/eligible': { role: 'MERCHANT', status: 'ACTIVE' },
    'users/existing': { role: 'MERCHANT', status: 'ACTIVE' },
    'users/paid': { role: 'MERCHANT', status: 'ACTIVE' },
    'users/inactive': { role: 'MERCHANT', status: 'INACTIVE' },
    'users/suspended': { role: 'MERCHANT', status: 'SUSPENDED' },
    'users/intent': { role: 'MERCHANT', status: 'ACTIVE' },
    'users/customer': { role: 'CUSTOMER', status: 'ACTIVE' },
    'merchantAccounts/existing': { balanceMinor: 999, currency: 'LKR', status: 'FROZEN' },
    'transactions/paid1': { merchantUid: 'paid', status: 'SUCCESS' },
    'paymentIntents/paid2': { merchantUid: 'intent', status: 'SUCCESS' },
  });
  const summary = await backfillMerchantAccounts(fake.db);
  assert.deepEqual(summary, { scanned: 6, eligible: 1, created: 0, existing: 1, review: 4, errors: 0 });
  assert.equal(fake.writes, 0);
  assert.equal(fake.records.has('merchantAccounts/eligible'), false);
  assert.deepEqual(fake.records.get('merchantAccounts/existing'), {
    balanceMinor: 999, currency: 'LKR', status: 'FROZEN',
  });
});

test('apply creates only eligible accounts and repeated execution is safe', async () => {
  const fake = fakeDb({ 'users/eligible': { role: 'MERCHANT', status: 'ACTIVE' } });
  const first = await backfillMerchantAccounts(fake.db, { apply: true });
  assert.equal(first.created, 1);
  assert.equal(fake.writes, 1);
  assert.deepEqual(fake.records.get('merchantAccounts/eligible'), {
    balanceMinor: 0, currency: 'LKR', status: 'ACTIVE',
  });
  const second = await backfillMerchantAccounts(fake.db, { apply: true });
  assert.equal(second.existing, 1);
  assert.equal(fake.writes, 1);
});

test('concurrent account creation and transaction errors do not overwrite data', async () => {
  const fake = fakeDb({ 'users/eligible': { role: 'MERCHANT', status: 'ACTIVE' } });
  fake.beforeNextCommit(() => fake.records.set('merchantAccounts/eligible', {
    balanceMinor: 700, currency: 'LKR', status: 'SUSPENDED',
  }));
  const results = [];
  const concurrent = await backfillMerchantAccounts(fake.db, { apply: true, onResult: (value) => results.push(value) });
  assert.equal(concurrent.errors, 1);
  assert.match(results[0].reason, /already exists/);
  assert.equal(fake.writes, 0);
  assert.equal(fake.records.get('merchantAccounts/eligible').balanceMinor, 700);
  fake.records.delete('merchantAccounts/eligible');
  fake.failNextCommit();
  const failed = await backfillMerchantAccounts(fake.db, { apply: true });
  assert.equal(failed.errors, 1);
  assert.equal(fake.records.has('merchantAccounts/eligible'), false);
});

test('apply requires a project identifier', () => {
  assert.deepEqual(parseArgs([]), { apply: false, projectId: undefined });
  assert.throws(() => parseArgs(['--apply']), /project-id/);
  assert.deepEqual(parseArgs(['--apply', '--project-id=demo-vpay-test']), {
    apply: true, projectId: 'demo-vpay-test',
  });
});
