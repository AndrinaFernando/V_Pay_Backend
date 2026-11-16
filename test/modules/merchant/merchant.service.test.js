const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MERCHANT_BALANCE_OUTCOMES,
  createMerchantService,
} = require('../../../src/modules/merchant/merchant.service');

function makeDb(records) {
  const reads = [];
  const db = {
    collection(name) {
      return {
        doc(uid) {
          return {
            async get() {
              reads.push(`${name}/${uid}`);
              const data = records.get(`${name}/${uid}`);
              return { exists: data !== undefined, data: () => data };
            },
          };
        },
      };
    },
  };
  return { db, reads };
}

function merchantRecords(wallet = {}) {
  return new Map([
    ['users/merchant-uid', { role: 'MERCHANT', status: 'ACTIVE' }],
    [
      'merchantAccounts/merchant-uid',
      { balanceMinor: 42500, currency: 'LKR', status: 'ACTIVE', ...wallet },
    ],
  ]);
}

test('reads an active merchant LKR wallet using the verified UID', async () => {
  const records = merchantRecords();
  const { db, reads } = makeDb(records);
  const result = await createMerchantService({ db }).getBalance({
    uid: 'merchant-uid',
  });

  assert.deepEqual(result, {
    outcome: MERCHANT_BALANCE_OUTCOMES.FOUND,
    balance: { balanceMinor: 42500, currency: 'LKR' },
  });
  assert.deepEqual(reads, ['users/merchant-uid', 'merchantAccounts/merchant-uid']);
  assert.deepEqual(records.get('merchantAccounts/merchant-uid'), {
    balanceMinor: 42500,
    currency: 'LKR',
    status: 'ACTIVE',
  });
});

test('rejects missing profiles and non-merchant or inactive users', async () => {
  const { db } = makeDb(new Map());
  const service = createMerchantService({ db });
  assert.deepEqual(await service.getBalance({ uid: 'missing' }), {
    outcome: MERCHANT_BALANCE_OUTCOMES.PROFILE_NOT_FOUND,
  });

  for (const user of [
    { role: 'CUSTOMER', status: 'ACTIVE' },
    { role: 'MERCHANT', status: 'SUSPENDED' },
  ]) {
    const records = new Map([['users/merchant-uid', user]]);
    const result = await createMerchantService({ db: makeDb(records).db })
      .getBalance({ uid: 'merchant-uid' });
    assert.deepEqual(result, {
      outcome: MERCHANT_BALANCE_OUTCOMES.ROLE_FORBIDDEN,
    });
  }
});

test('does not create a missing wallet', async () => {
  const records = new Map([
    ['users/merchant-uid', { role: 'MERCHANT', status: 'ACTIVE' }],
  ]);
  const { db } = makeDb(records);
  const result = await createMerchantService({ db }).getBalance({
    uid: 'merchant-uid',
  });
  assert.deepEqual(result, {
    outcome: MERCHANT_BALANCE_OUTCOMES.WALLET_NOT_FOUND,
  });
  assert.equal(records.has('merchantAccounts/merchant-uid'), false);
});

test('rejects inactive wallets and unexpected currencies', async () => {
  for (const wallet of [
    { status: 'FROZEN' },
    { currency: 'USD' },
  ]) {
    const result = await createMerchantService({
      db: makeDb(merchantRecords(wallet)).db,
    }).getBalance({ uid: 'merchant-uid' });
    assert.deepEqual(result, {
      outcome: MERCHANT_BALANCE_OUTCOMES.WALLET_UNAVAILABLE,
    });
  }
});

test('rejects malformed, negative, fractional, and unsafe balance values', async () => {
  for (const balanceMinor of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await createMerchantService({
      db: makeDb(merchantRecords({ balanceMinor })).db,
    }).getBalance({ uid: 'merchant-uid' });
    assert.deepEqual(result, {
      outcome: MERCHANT_BALANCE_OUTCOMES.INVALID_WALLET,
    });
  }
});
