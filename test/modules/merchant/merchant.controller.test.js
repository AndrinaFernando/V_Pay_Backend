const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const records = new Map();
const reads = [];
let throwOnRead = false;
const db = {
  collection(name) {
    return {
      doc(uid) {
        return {
          async get() {
            reads.push(`${name}/${uid}`);
            if (throwOnRead) throw new Error('private database detail');
            const data = records.get(`${name}/${uid}`);
            return { exists: data !== undefined, data: () => data };
          },
        };
      },
    };
  },
};

const firebaseConfigPath = require.resolve('../../../src/config/firebase');
const firebaseConfigStub = new Module(firebaseConfigPath);
firebaseConfigStub.filename = firebaseConfigPath;
firebaseConfigStub.loaded = true;
firebaseConfigStub.exports = { db };
require.cache[firebaseConfigPath] = firebaseConfigStub;

const { getBalance } = require('../../../src/modules/merchant/merchant.controller');

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function setActiveMerchant(uid = 'verified-merchant-uid') {
  records.clear();
  reads.length = 0;
  throwOnRead = false;
  records.set(`users/${uid}`, { role: 'MERCHANT', status: 'ACTIVE' });
  records.set(`merchantAccounts/${uid}`, {
    balanceMinor: 0,
    currency: 'LKR',
    status: 'ACTIVE',
  });
}

test('returns balance for the authenticated UID and ignores client UID values', async () => {
  setActiveMerchant();
  records.set('merchantAccounts/client-supplied-uid', {
    balanceMinor: 999999,
    currency: 'LKR',
    status: 'ACTIVE',
  });
  const res = makeResponse();

  await getBalance(
    {
      user: { uid: 'verified-merchant-uid', emailVerified: true },
      params: { uid: 'client-supplied-uid' },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    data: { balanceMinor: 0, currency: 'LKR' },
  });
  assert.deepEqual(reads, [
    'users/verified-merchant-uid',
    'merchantAccounts/verified-merchant-uid',
  ]);
});

test('requires verified email before reading wallet data', async () => {
  setActiveMerchant();
  const res = makeResponse();
  await getBalance(
    { user: { uid: 'verified-merchant-uid', emailVerified: false } },
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.equal(reads.length, 0);
});

test('returns safe status codes for forbidden, missing, and malformed wallets', async () => {
  setActiveMerchant();
  records.set('users/verified-merchant-uid', {
    role: 'CUSTOMER',
    status: 'ACTIVE',
  });
  let res = makeResponse();
  await getBalance(
    { user: { uid: 'verified-merchant-uid', emailVerified: true } },
    res,
  );
  assert.equal(res.statusCode, 403);

  setActiveMerchant();
  records.delete('merchantAccounts/verified-merchant-uid');
  res = makeResponse();
  await getBalance(
    { user: { uid: 'verified-merchant-uid', emailVerified: true } },
    res,
  );
  assert.equal(res.statusCode, 404);

  setActiveMerchant();
  records.set('merchantAccounts/verified-merchant-uid', {
    balanceMinor: -1,
    currency: 'LKR',
    status: 'ACTIVE',
  });
  res = makeResponse();
  await getBalance(
    { user: { uid: 'verified-merchant-uid', emailVerified: true } },
    res,
  );
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    success: false,
    message: 'Merchant balance is unavailable',
  });
});

test('hides Firestore error details', async () => {
  setActiveMerchant();
  throwOnRead = true;
  const res = makeResponse();
  await getBalance(
    { user: { uid: 'verified-merchant-uid', emailVerified: true } },
    res,
  );
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, 'Unable to retrieve merchant balance');
  assert.equal(JSON.stringify(res.body).includes('private database detail'), false);
});
