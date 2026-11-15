const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function createFakeDb() {
  const records = new Map();
  let failNextCommit = false;
  let transactionQueue = Promise.resolve();

  function key(ref) {
    return `${ref.collectionName}/${ref.id}`;
  }

  function snapshot(ref) {
    const data = records.get(key(ref));
    return {
      exists: data !== undefined,
      data: () => data,
    };
  }

  const db = {
    collection(collectionName) {
      return {
        doc(id) {
          return {
            collectionName,
            id,
            get: async () => snapshot({ collectionName, id }),
          };
        },
      };
    },
    runTransaction(callback) {
      const run = async () => {
        const writes = [];
        let writeStarted = false;
        const transaction = {
          async get(ref) {
            assert.equal(writeStarted, false, 'transaction reads must precede writes');
            return snapshot(ref);
          },
          set(ref, data) {
            writeStarted = true;
            writes.push({ type: 'set', ref, data });
          },
          update(ref, data) {
            writeStarted = true;
            writes.push({ type: 'update', ref, data });
          },
        };

        const result = await callback(transaction);
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error('simulated transaction commit failure');
        }

        for (const write of writes) {
          const recordKey = key(write.ref);
          if (write.type === 'update' && !records.has(recordKey)) {
            throw new Error('cannot update a missing document');
          }
          const prior = records.get(recordKey) || {};
          records.set(recordKey, { ...prior, ...write.data });
        }

        return result;
      };

      const result = transactionQueue.then(run, run);
      transactionQueue = result.catch(() => {});
      return result;
    },
  };

  return {
    db,
    records,
    failNextTransactionCommit() {
      failNextCommit = true;
    },
    reset() {
      records.clear();
      failNextCommit = false;
      transactionQueue = Promise.resolve();
    },
  };
}

const fake = createFakeDb();
const firebaseConfigPath = require.resolve('../../../src/config/firebase');
const firebaseConfigStub = new Module(firebaseConfigPath);
firebaseConfigStub.filename = firebaseConfigPath;
firebaseConfigStub.loaded = true;
firebaseConfigStub.exports = { db: fake.db };
require.cache[firebaseConfigPath] = firebaseConfigStub;

const {
  BOOTSTRAP_OUTCOMES,
  bootstrapUser,
} = require('../../../src/modules/users/user.service');

function merchantInput(overrides = {}) {
  return {
    uid: 'merchant1',
    email: 'merchant@example.test',
    name: 'Merchant Owner',
    phone: '+94771234567',
    role: 'MERCHANT',
    businessName: 'Test Merchant',
    businessCategory: 'Retail',
    businessAddress: '1 Test Street',
    ...overrides,
  };
}

test.beforeEach(() => {
  fake.reset();
});

test('new merchant bootstrap atomically provisions an empty active LKR wallet', async () => {
  const result = await bootstrapUser(merchantInput());

  assert.equal(result.outcome, BOOTSTRAP_OUTCOMES.CREATED);
  assert.equal(result.user.role, 'MERCHANT');
  assert.equal(result.user.status, 'ACTIVE');
  assert.equal(result.card, null);
  assert.deepEqual(fake.records.get('merchantAccounts/merchant1'), {
    balanceMinor: 0,
    currency: 'LKR',
    status: 'ACTIVE',
  });
  assert.equal(fake.records.has('cards/merchant1'), false);
});

test('repeated merchant bootstrap never resets an existing wallet', async () => {
  assert.equal(
    (await bootstrapUser(merchantInput())).outcome,
    BOOTSTRAP_OUTCOMES.CREATED,
  );
  fake.records.set('merchantAccounts/merchant1', {
    balanceMinor: 75_500,
    currency: 'LKR',
    status: 'SUSPENDED',
  });

  const repeated = await bootstrapUser(merchantInput());

  assert.equal(repeated.outcome, BOOTSTRAP_OUTCOMES.EXISTING);
  assert.deepEqual(fake.records.get('merchantAccounts/merchant1'), {
    balanceMinor: 75_500,
    currency: 'LKR',
    status: 'SUSPENDED',
  });
});

test('concurrent merchant bootstrap provisions exactly one wallet without resetting it', async () => {
  const results = await Promise.all([
    bootstrapUser(merchantInput()),
    bootstrapUser(merchantInput()),
  ]);

  assert.deepEqual(
    results.map(({ outcome }) => outcome),
    [BOOTSTRAP_OUTCOMES.CREATED, BOOTSTRAP_OUTCOMES.EXISTING],
  );
  assert.deepEqual(fake.records.get('merchantAccounts/merchant1'), {
    balanceMinor: 0,
    currency: 'LKR',
    status: 'ACTIVE',
  });
});

test('role conflicts do not create merchant wallets or alter customer data', async () => {
  const existingCustomer = {
    role: 'CUSTOMER',
    status: 'ACTIVE',
    balanceMarker: 'unchanged',
  };
  fake.records.set('users/merchant1', existingCustomer);

  const result = await bootstrapUser(merchantInput());

  assert.equal(result.outcome, BOOTSTRAP_OUTCOMES.ROLE_CONFLICT);
  assert.deepEqual(fake.records.get('users/merchant1'), existingCustomer);
  assert.equal(fake.records.has('merchantAccounts/merchant1'), false);
});

test('existing merchant wallet is preserved exactly', async () => {
  fake.records.set('users/merchant1', {
    role: 'MERCHANT',
    status: 'ACTIVE',
    name: 'Merchant Owner',
    phone: '+94771234567',
    businessName: 'Test Merchant',
    businessCategory: 'Retail',
    businessAddress: '1 Test Street',
  });
  const wallet = {
    balanceMinor: 98_765,
    currency: 'LKR',
    status: 'FROZEN',
    reconciliationMarker: 'preserve-me',
  };
  fake.records.set('merchantAccounts/merchant1', wallet);

  const result = await bootstrapUser(merchantInput());

  assert.equal(result.outcome, BOOTSTRAP_OUTCOMES.EXISTING);
  assert.deepEqual(fake.records.get('merchantAccounts/merchant1'), wallet);
});

test('existing merchants without wallets are left for explicit migration', async () => {
  for (const status of ['ACTIVE', 'SUSPENDED']) {
    fake.reset();
    fake.records.set('users/merchant1', {
      role: 'MERCHANT',
      status,
      name: 'Merchant Owner',
      phone: '+94771234567',
      businessName: 'Test Merchant',
      businessCategory: 'Retail',
      businessAddress: '1 Test Street',
    });

    const result = await bootstrapUser(merchantInput());

    assert.equal(result.outcome, BOOTSTRAP_OUTCOMES.EXISTING);
    assert.equal(fake.records.has('merchantAccounts/merchant1'), false);
  }
});

test('transaction failure rolls back both merchant profile and wallet', async () => {
  fake.failNextTransactionCommit();

  await assert.rejects(
    bootstrapUser(merchantInput()),
    /transaction commit failure/,
  );

  assert.equal(fake.records.has('users/merchant1'), false);
  assert.equal(fake.records.has('merchantAccounts/merchant1'), false);
});

test('customer bootstrap still provisions only the existing virtual-card schema', async () => {
  const result = await bootstrapUser({
    uid: 'customer1',
    email: 'customer@example.test',
    name: 'Test Customer',
    phone: '+94771234567',
    role: 'CUSTOMER',
  });

  assert.equal(result.outcome, BOOTSTRAP_OUTCOMES.CREATED);
  assert.equal(result.card.ownerId, 'customer1');
  assert.equal(result.card.balance, 0);
  assert.equal(result.card.status, 'ACTIVE');
  assert.equal(fake.records.has('merchantAccounts/customer1'), false);
});
