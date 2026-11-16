const { generateKeyPairSync, randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { cert, deleteApp, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const REQUIRED_EMULATOR_HOST = '127.0.0.1:8188';
const REQUIRED_PROJECT_ID = 'demo-vpay-test';
const emulatorIsSafe =
  process.env.FIRESTORE_EMULATOR_HOST === REQUIRED_EMULATOR_HOST &&
  process.env.FIRESTORE_EMULATOR_PROJECT_ID === REQUIRED_PROJECT_ID;
const skipReason = emulatorIsSafe
  ? false
  : `requires FIRESTORE_EMULATOR_HOST=${REQUIRED_EMULATOR_HOST} and FIRESTORE_EMULATOR_PROJECT_ID=${REQUIRED_PROJECT_ID}`;

test.describe('merchant wallet provisioning with the Firestore emulator', {
  skip: skipReason,
}, () => {
  let app;
  let bootstrapUser;
  let db;
  let trackedRefs;

  test.before(() => {
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, REQUIRED_EMULATOR_HOST);
    assert.equal(
      process.env.FIRESTORE_EMULATOR_PROJECT_ID,
      REQUIRED_PROJECT_ID,
    );

    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    app = initializeApp(
      {
        credential: cert({
          projectId: REQUIRED_PROJECT_ID,
          clientEmail: `firestore-emulator@${REQUIRED_PROJECT_ID}.iam.gserviceaccount.com`,
          privateKey,
        }),
        projectId: REQUIRED_PROJECT_ID,
      },
      `merchant-wallet-emulator-${process.pid}-${randomUUID()}`,
    );
    db = getFirestore(app);

    const firebaseConfigPath = require.resolve('../../../src/config/firebase');
    const firebaseConfigStub = new Module(firebaseConfigPath);
    firebaseConfigStub.filename = firebaseConfigPath;
    firebaseConfigStub.loaded = true;
    firebaseConfigStub.exports = { db };
    require.cache[firebaseConfigPath] = firebaseConfigStub;
    ({ bootstrapUser } = require('../../../src/modules/users/user.service'));
  });

  test.beforeEach(() => {
    trackedRefs = [];
  });

  test.afterEach(async () => {
    const batch = db.batch();
    for (const ref of trackedRefs) batch.delete(ref);
    await batch.commit();
  });

  test.after(async () => {
    await deleteApp(app);
  });

  function refs(uid) {
    const result = {
      user: db.collection('users').doc(uid),
      wallet: db.collection('merchantAccounts').doc(uid),
      card: db.collection('cards').doc(uid),
    };
    trackedRefs.push(result.user, result.wallet, result.card);
    return result;
  }

  function merchantInput(uid) {
    return {
      uid,
      email: `${uid}@example.test`,
      name: 'Merchant Owner',
      phone: '+94771234567',
      role: 'MERCHANT',
      businessName: 'Emulator Merchant',
      businessCategory: 'Retail',
      businessAddress: '1 Emulator Street',
    };
  }

  test('concurrent bootstrap creates one wallet and repeated bootstrap preserves it', async () => {
    const uid = `merchant-${randomUUID()}`;
    const merchantRefs = refs(uid);

    const results = await Promise.all([
      bootstrapUser(merchantInput(uid)),
      bootstrapUser(merchantInput(uid)),
    ]);
    const wallet = await merchantRefs.wallet.get();
    const card = await merchantRefs.card.get();

    assert.deepEqual(
      results.map(({ outcome }) => outcome).sort(),
      ['CREATED', 'EXISTING'],
    );
    assert.deepEqual(wallet.data(), {
      balanceMinor: 0,
      currency: 'LKR',
      status: 'ACTIVE',
    });
    assert.equal(card.exists, false);

    await merchantRefs.wallet.update({
      balanceMinor: 42_500,
      status: 'SUSPENDED',
    });
    const repeated = await bootstrapUser(merchantInput(uid));
    const preservedWallet = await merchantRefs.wallet.get();

    assert.equal(repeated.outcome, 'EXISTING');
    assert.deepEqual(preservedWallet.data(), {
      balanceMinor: 42_500,
      currency: 'LKR',
      status: 'SUSPENDED',
    });
  });

  test('existing active merchant without a wallet is initialized', async () => {
    const uid = `existing-merchant-${randomUUID()}`;
    const merchantRefs = refs(uid);
    await merchantRefs.user.set({
      role: 'MERCHANT',
      status: 'ACTIVE',
      name: 'Existing Merchant',
      phone: '+94771234567',
      businessName: 'Existing Business',
      businessCategory: 'Retail',
      businessAddress: '2 Emulator Street',
    });

    const result = await bootstrapUser(merchantInput(uid));
    const wallet = await merchantRefs.wallet.get();

    assert.equal(result.outcome, 'EXISTING');
    assert.deepEqual(wallet.data(), {
      balanceMinor: 0,
      currency: 'LKR',
      status: 'ACTIVE',
    });
  });
});
