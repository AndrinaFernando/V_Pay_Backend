const { generateKeyPairSync, randomUUID } = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const { cert, deleteApp, initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const {
  PAYMENT_EXECUTION_OUTCOMES,
  PAYMENT_INTENT_OUTCOMES,
  PAYMENT_INTENT_STATUS,
  buildQrTransactionId,
  createPaymentService,
} = require('../../../src/modules/payments/payment.service');

const REQUIRED_EMULATOR_HOST = '127.0.0.1:8188';
const REQUIRED_PROJECT_ID = 'demo-vpay-test';
const emulatorIsSafe =
  process.env.FIRESTORE_EMULATOR_HOST === REQUIRED_EMULATOR_HOST &&
  process.env.FIRESTORE_EMULATOR_PROJECT_ID === REQUIRED_PROJECT_ID;
const skipReason = emulatorIsSafe
  ? false
  : `requires FIRESTORE_EMULATOR_HOST=${REQUIRED_EMULATOR_HOST} and FIRESTORE_EMULATOR_PROJECT_ID=${REQUIRED_PROJECT_ID}`;

const NOW = new Date('2026-11-15T10:00:00.000Z');
const FUTURE = new Date('2026-11-15T11:00:00.000Z');
const PAST = new Date('2026-11-15T09:00:00.000Z');

test.describe('QR payments with the Firestore emulator', { skip: skipReason }, () => {
  let app;
  let db;
  let service;
  let trackedPaths;

  test.before(() => {
    assert.equal(
      process.env.FIRESTORE_EMULATOR_HOST,
      REQUIRED_EMULATOR_HOST,
    );
    assert.equal(
      process.env.FIRESTORE_EMULATOR_PROJECT_ID,
      REQUIRED_PROJECT_ID,
    );

    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const emulatorCredential = cert({
      projectId: REQUIRED_PROJECT_ID,
      clientEmail: `firestore-emulator@${REQUIRED_PROJECT_ID}.iam.gserviceaccount.com`,
      privateKey,
    });
    app = initializeApp(
      {
        credential: emulatorCredential,
        projectId: REQUIRED_PROJECT_ID,
      },
      `vpay-emulator-${process.pid}-${randomUUID()}`,
    );
    db = getFirestore(app);
    service = createPaymentService({
      db,
      clock: () => new Date(NOW),
      executionEnabled: () => true,
    });
  });

  test.beforeEach(() => {
    trackedPaths = new Set();
  });

  test.afterEach(async () => {
    const paths = [...trackedPaths];
    for (let index = 0; index < paths.length; index += 400) {
      const batch = db.batch();
      for (const path of paths.slice(index, index + 400)) {
        batch.delete(db.doc(path));
      }
      await batch.commit();
    }
  });

  test.after(async () => {
    await deleteApp(app);
  });

  function uniqueId(label) {
    return `${label}-${randomUUID()}`;
  }

  function track(ref) {
    trackedPaths.add(ref.path);
    return ref;
  }

  async function seedScenario({
    amountMinor = 12550,
    customerBalanceMinor = 100000,
    merchantBalanceMinor = 10000,
    cardCurrency,
    cardStatus = 'ACTIVE',
    cardExpiresAt = FUTURE,
    intentExpiresAt = FUTURE,
    intentStatus = PAYMENT_INTENT_STATUS.PENDING,
    includeMerchantAccount = true,
  } = {}) {
    const customerUid = uniqueId('customer');
    const otherCustomerUid = uniqueId('other-customer');
    const merchantUid = uniqueId('merchant');
    const paymentReference = uniqueId('intent');
    const transactionId = buildQrTransactionId(paymentReference);
    const refs = {
      customer: track(db.collection('users').doc(customerUid)),
      otherCustomer: track(db.collection('users').doc(otherCustomerUid)),
      merchant: track(db.collection('users').doc(merchantUid)),
      card: track(db.collection('cards').doc(customerUid)),
      merchantAccount: track(
        db.collection('merchantAccounts').doc(merchantUid),
      ),
      intent: track(
        db.collection('paymentIntents').doc(paymentReference),
      ),
      transaction: track(db.collection('transactions').doc(transactionId)),
    };
    const batch = db.batch();
    batch.set(refs.customer, { role: 'CUSTOMER', status: 'ACTIVE' });
    batch.set(refs.otherCustomer, {
      role: 'CUSTOMER',
      status: 'ACTIVE',
    });
    batch.set(refs.merchant, {
      role: 'MERCHANT',
      status: 'ACTIVE',
      businessName: 'Emulator Merchant',
    });
    batch.set(refs.card, {
      ownerId: customerUid,
      balance: customerBalanceMinor / 100,
      ...(cardCurrency !== undefined && { currency: cardCurrency }),
      status: cardStatus,
      expiresAt: cardExpiresAt,
    });
    if (includeMerchantAccount) {
      batch.set(refs.merchantAccount, {
        balanceMinor: merchantBalanceMinor,
        currency: 'LKR',
        status: 'ACTIVE',
      });
    }
    batch.set(refs.intent, {
      merchantUid,
      merchantName: 'Emulator Merchant',
      amountMinor,
      currency: 'LKR',
      status: intentStatus,
      createdAt: PAST,
      expiresAt: intentExpiresAt,
    });
    await batch.commit();

    return {
      amountMinor,
      customerBalanceMinor,
      customerUid,
      merchantBalanceMinor,
      merchantUid,
      otherCustomerUid,
      paymentReference,
      transactionId,
      refs,
    };
  }

  async function confirm(scenario, customerUid = scenario.customerUid) {
    return service.confirmPaymentIntent({
      uid: customerUid,
      paymentReference: scenario.paymentReference,
    });
  }

  test('successful payment persists one balanced transfer and ledger', async () => {
    const scenario = await seedScenario();

    const result = await confirm(scenario);
    const [card, account, intent, transaction] = await Promise.all([
      scenario.refs.card.get(),
      scenario.refs.merchantAccount.get(),
      scenario.refs.intent.get(),
      scenario.refs.transaction.get(),
    ]);
    const ledgerQuery = await db
      .collection('transactions')
      .where('paymentReference', '==', scenario.paymentReference)
      .get();

    assert.equal(result.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
    assert.equal(
      card.data().balance,
      (scenario.customerBalanceMinor - scenario.amountMinor) / 100,
    );
    assert.equal(
      account.data().balanceMinor,
      scenario.merchantBalanceMinor + scenario.amountMinor,
    );
    assert.equal(intent.data().status, PAYMENT_INTENT_STATUS.SUCCESS);
    assert.equal(intent.data().customerUid, scenario.customerUid);
    assert.equal(transaction.exists, true);
    assert.equal(transaction.id, scenario.transactionId);
    assert.equal(transaction.data().type, 'QR_PAYMENT');
    assert.equal(transaction.data().customerUid, scenario.customerUid);
    assert.equal(transaction.data().merchantUid, scenario.merchantUid);
    assert.equal(transaction.data().amountMinor, scenario.amountMinor);
    assert.equal(transaction.data().currency, 'LKR');
    assert.equal(transaction.data().status, PAYMENT_INTENT_STATUS.SUCCESS);
    assert.equal(
      transaction.data().createdAt.toMillis(),
      intent.data().paidAt.toMillis(),
    );
    assert.equal(result.payment.paidAt, intent.data().paidAt.toDate().toISOString());
    assert.equal(ledgerQuery.size, 1);
  });

  test('enforces payment amount boundaries in real Firestore transactions', async () => {
    const cases = [
      [500, PAYMENT_EXECUTION_OUTCOMES.PAYMENT_BELOW_MINIMUM, false],
      [1_000, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED, true],
      [500_000, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED, true],
      [2_000_000, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED, true],
      [2_000_001, PAYMENT_EXECUTION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED, false],
      [2_500_000, PAYMENT_EXECUTION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED, false],
    ];

    for (const [amountMinor, outcome, succeeds] of cases) {
      const scenario = await seedScenario({
        amountMinor,
        customerBalanceMinor: 3_000_000,
      });

      const result = await confirm(scenario);
      const [card, account, intent, transaction] = await Promise.all([
        scenario.refs.card.get(),
        scenario.refs.merchantAccount.get(),
        scenario.refs.intent.get(),
        scenario.refs.transaction.get(),
      ]);

      assert.equal(result.outcome, outcome);
      assert.equal(
        card.data().balance,
        (succeeds ? 3_000_000 - amountMinor : 3_000_000) / 100,
      );
      assert.equal(
        account.data().balanceMinor,
        succeeds ? 10_000 + amountMinor : 10_000,
      );
      assert.equal(
        intent.data().status,
        succeeds
          ? PAYMENT_INTENT_STATUS.SUCCESS
          : PAYMENT_INTENT_STATUS.PENDING,
      );
      assert.equal(transaction.exists, succeeds);
    }
  });

  test('enforces the retained-balance boundary in real Firestore transactions', async () => {
    const cases = [
      [200_000, 100_000, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED, 100_000],
      [200_000, 150_000, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED, 50_000],
      [200_000, 150_100, PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED],
      [50_000, 1_000, PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED],
      [51_000, 1_000, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED, 50_000],
      [40_000, 1_000, PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED],
      [10_000, 20_000, PAYMENT_EXECUTION_OUTCOMES.INSUFFICIENT_BALANCE],
    ];

    for (const [balanceMinor, amountMinor, outcome, resultingBalanceMinor] of cases) {
      const scenario = await seedScenario({
        amountMinor,
        customerBalanceMinor: balanceMinor,
      });

      const result = await confirm(scenario);
      const [card, account, intent, transaction] = await Promise.all([
        scenario.refs.card.get(),
        scenario.refs.merchantAccount.get(),
        scenario.refs.intent.get(),
        scenario.refs.transaction.get(),
      ]);

      assert.equal(result.outcome, outcome);
      assert.equal(
        card.data().balance,
        (resultingBalanceMinor ?? balanceMinor) / 100,
      );
      assert.equal(
        account.data().balanceMinor,
        outcome === PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED
          ? scenario.merchantBalanceMinor + amountMinor
          : scenario.merchantBalanceMinor,
      );
      assert.equal(transaction.exists, outcome === PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
      assert.equal(
        intent.data().status,
        outcome === PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED
          ? PAYMENT_INTENT_STATUS.SUCCESS
          : PAYMENT_INTENT_STATUS.PENDING,
      );
    }
  });

  test('concurrent confirmation transfers once and preserves payer ownership', async () => {
    const scenario = await seedScenario();

    const settled = await Promise.allSettled([
      confirm(scenario),
      confirm(scenario),
    ]);
    assert.equal(settled.every(({ status }) => status === 'fulfilled'), true);
    const results = settled.map(({ value }) => value);
    assert.equal(
      results.every(
        ({ outcome }) => outcome === PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
      ),
      true,
    );
    assert.equal(results.filter(({ idempotent }) => idempotent).length, 1);

    const duplicate = await confirm(scenario);
    assert.equal(duplicate.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.payment.transactionId, scenario.transactionId);

    const otherCustomer = await confirm(scenario, scenario.otherCustomerUid);
    assert.equal(
      otherCustomer.outcome,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_ALREADY_PAID,
    );

    const [card, account, ledgerQuery] = await Promise.all([
      scenario.refs.card.get(),
      scenario.refs.merchantAccount.get(),
      db
        .collection('transactions')
        .where('paymentReference', '==', scenario.paymentReference)
        .get(),
    ]);
    assert.equal(
      card.data().balance,
      (scenario.customerBalanceMinor - scenario.amountMinor) / 100,
    );
    assert.equal(
      account.data().balanceMinor,
      scenario.merchantBalanceMinor + scenario.amountMinor,
    );
    assert.equal(ledgerQuery.size, 1);
  });

  test('two customers racing for one QR debit only the winner', async () => {
    const scenario = await seedScenario();
    const otherCustomerBalanceMinor = 80000;
    const otherCard = track(
      db.collection('cards').doc(scenario.otherCustomerUid),
    );
    await otherCard.set({
      ownerId: scenario.otherCustomerUid,
      balance: otherCustomerBalanceMinor / 100,
      status: 'ACTIVE',
      expiresAt: FUTURE,
    });

    const settled = await Promise.allSettled([
      confirm(scenario, scenario.customerUid),
      confirm(scenario, scenario.otherCustomerUid),
    ]);
    assert.equal(settled.every(({ status }) => status === 'fulfilled'), true);
    const results = settled.map(({ value }) => value);
    assert.deepEqual(
      results.map(({ outcome }) => outcome).sort(),
      [
        PAYMENT_EXECUTION_OUTCOMES.PAYMENT_ALREADY_PAID,
        PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
      ].sort(),
    );

    const customerUids = [
      scenario.customerUid,
      scenario.otherCustomerUid,
    ];
    const winnerIndex = results.findIndex(
      ({ outcome }) => outcome === PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
    );
    const loserIndex = 1 - winnerIndex;
    const winnerUid = customerUids[winnerIndex];
    const loserUid = customerUids[loserIndex];
    const initialBalances = new Map([
      [scenario.customerUid, scenario.customerBalanceMinor],
      [scenario.otherCustomerUid, otherCustomerBalanceMinor],
    ]);

    const [customerCard, competingCard, account, intent, ledgerQuery] =
      await Promise.all([
        scenario.refs.card.get(),
        otherCard.get(),
        scenario.refs.merchantAccount.get(),
        scenario.refs.intent.get(),
        db
          .collection('transactions')
          .where('paymentReference', '==', scenario.paymentReference)
          .get(),
      ]);
    const persistedBalances = new Map([
      [scenario.customerUid, customerCard.data().balance * 100],
      [scenario.otherCustomerUid, competingCard.data().balance * 100],
    ]);

    assert.equal(
      persistedBalances.get(winnerUid),
      initialBalances.get(winnerUid) - scenario.amountMinor,
    );
    assert.equal(
      persistedBalances.get(loserUid),
      initialBalances.get(loserUid),
    );
    assert.equal(
      account.data().balanceMinor,
      scenario.merchantBalanceMinor + scenario.amountMinor,
    );
    assert.equal(intent.data().status, PAYMENT_INTENT_STATUS.SUCCESS);
    assert.equal(intent.data().customerUid, winnerUid);
    assert.equal(ledgerQuery.size, 1);
    assert.equal(ledgerQuery.docs[0].data().type, 'QR_PAYMENT');
    assert.equal(ledgerQuery.docs[0].data().customerUid, winnerUid);

    const losingReceipt = await service.getPaymentStatus({
      uid: loserUid,
      paymentReference: scenario.paymentReference,
    });
    assert.equal(
      losingReceipt.outcome,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND,
    );
    assert.equal('payment' in losingReceipt, false);
  });

  test('concurrent spending preserves the retained balance', async () => {
    const scenario = await seedScenario({
      amountMinor: 10000,
      customerBalanceMinor: 65000,
      merchantBalanceMinor: 2000,
    });
    const secondReference = uniqueId('intent');
    const secondIntent = track(
      db.collection('paymentIntents').doc(secondReference),
    );
    const secondTransaction = track(
      db
        .collection('transactions')
        .doc(buildQrTransactionId(secondReference)),
    );
    await secondIntent.set({
      merchantUid: scenario.merchantUid,
      merchantName: 'Emulator Merchant',
      amountMinor: 10000,
      currency: 'LKR',
      status: PAYMENT_INTENT_STATUS.PENDING,
      createdAt: PAST,
      expiresAt: FUTURE,
    });

    const settled = await Promise.allSettled([
      confirm(scenario),
      service.confirmPaymentIntent({
        uid: scenario.customerUid,
        paymentReference: secondReference,
      }),
    ]);
    assert.equal(settled.every(({ status }) => status === 'fulfilled'), true);
    const outcomes = settled.map(({ value }) => value.outcome).sort();
    assert.deepEqual(outcomes, [
      PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED,
      PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED,
    ].sort());

    const [card, account, firstIntent, laterIntent, firstLedger, laterLedger] =
      await Promise.all([
        scenario.refs.card.get(),
        scenario.refs.merchantAccount.get(),
        scenario.refs.intent.get(),
        secondIntent.get(),
        scenario.refs.transaction.get(),
        secondTransaction.get(),
      ]);
    assert.equal(card.data().balance, 550);
    assert.ok(card.data().balance >= 500);
    assert.equal(account.data().balanceMinor, 12000);
    const intentStatuses = [
      firstIntent.data().status,
      laterIntent.data().status,
    ];
    assert.equal(
      intentStatuses.filter((status) => status === PAYMENT_INTENT_STATUS.SUCCESS)
        .length,
      1,
    );
    assert.equal(
      intentStatuses.filter((status) => status === PAYMENT_INTENT_STATUS.PENDING)
        .length,
      1,
    );
    assert.equal([firstLedger.exists, laterLedger.exists].filter(Boolean).length, 1);
  });

  test('validation failures never transfer funds or create ledgers', async () => {
    const cases = [
      {
        name: 'insufficient balance',
        options: { customerBalanceMinor: 12549 },
        outcome: PAYMENT_EXECUTION_OUTCOMES.INSUFFICIENT_BALANCE,
      },
      {
        name: 'minimum retained balance',
        options: { customerBalanceMinor: 62000 },
        outcome: PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED,
      },
      {
        name: 'frozen card',
        options: { cardStatus: 'FROZEN' },
        outcome: PAYMENT_EXECUTION_OUTCOMES.CARD_FROZEN,
      },
      {
        name: 'explicitly unsupported card currency',
        options: { cardCurrency: 'USD' },
        outcome: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY,
      },
      {
        name: 'expired card',
        options: { cardExpiresAt: NOW },
        outcome: PAYMENT_EXECUTION_OUTCOMES.CARD_EXPIRED,
      },
      {
        name: 'expired QR',
        options: { intentExpiresAt: NOW },
        outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_EXPIRED,
        expectedIntentStatus: PAYMENT_INTENT_STATUS.EXPIRED,
      },
      {
        name: 'terminally failed QR',
        options: { intentStatus: PAYMENT_INTENT_STATUS.FAILED },
        outcome: PAYMENT_EXECUTION_OUTCOMES.PAYMENT_FAILED,
        expectedIntentStatus: PAYMENT_INTENT_STATUS.FAILED,
      },
      {
        name: 'missing merchant account',
        options: { includeMerchantAccount: false },
        outcome: PAYMENT_EXECUTION_OUTCOMES.MERCHANT_UNAVAILABLE,
      },
    ];

    for (const failureCase of cases) {
      const scenario = await seedScenario(failureCase.options);
      const result = await confirm(scenario);
      const [card, account, intent, transaction] = await Promise.all([
        scenario.refs.card.get(),
        scenario.refs.merchantAccount.get(),
        scenario.refs.intent.get(),
        scenario.refs.transaction.get(),
      ]);

      assert.equal(result.outcome, failureCase.outcome, failureCase.name);
      assert.equal(
        card.data().balance,
        scenario.customerBalanceMinor / 100,
        failureCase.name,
      );
      if (account.exists) {
        assert.equal(
          account.data().balanceMinor,
          scenario.merchantBalanceMinor,
          failureCase.name,
        );
      }
      assert.equal(transaction.exists, false, failureCase.name);
      assert.equal(
        intent.data().status,
        failureCase.expectedIntentStatus || PAYMENT_INTENT_STATUS.PENDING,
        failureCase.name,
      );
    }
  });

  test('duplicate confirmation returns the original transaction without writes', async () => {
    const scenario = await seedScenario();
    const first = await confirm(scenario);
    const [cardBefore, accountBefore, transactionBefore] = await Promise.all([
      scenario.refs.card.get(),
      scenario.refs.merchantAccount.get(),
      scenario.refs.transaction.get(),
    ]);

    const duplicate = await confirm(scenario);
    const [cardAfter, accountAfter, transactionAfter, ledgerQuery] =
      await Promise.all([
        scenario.refs.card.get(),
        scenario.refs.merchantAccount.get(),
        scenario.refs.transaction.get(),
        db
          .collection('transactions')
          .where('paymentReference', '==', scenario.paymentReference)
          .get(),
      ]);

    assert.equal(first.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
    assert.equal(duplicate.outcome, PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED);
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.payment.transactionId, first.payment.transactionId);
    assert.equal(cardAfter.data().balance, cardBefore.data().balance);
    assert.equal(accountAfter.data().balanceMinor, accountBefore.data().balanceMinor);
    assert.equal(
      transactionAfter.updateTime.toMillis(),
      transactionBefore.updateTime.toMillis(),
    );
    assert.equal(ledgerQuery.size, 1);
  });

  test('payment-status recovery verifies ownership and ledger consistency', async () => {
    const scenario = await seedScenario();
    await confirm(scenario);
    const statusService = createPaymentService({
      db,
      clock: () => new Date(NOW),
      executionEnabled: () => false,
    });
    const snapshotsBefore = await Promise.all([
      scenario.refs.card.get(),
      scenario.refs.merchantAccount.get(),
      scenario.refs.intent.get(),
      scenario.refs.transaction.get(),
    ]);

    const original = await statusService.getPaymentStatus({
      uid: scenario.customerUid,
      paymentReference: scenario.paymentReference,
    });
    const repeated = await statusService.getPaymentStatus({
      uid: scenario.customerUid,
      paymentReference: scenario.paymentReference,
    });
    const otherCustomer = await statusService.getPaymentStatus({
      uid: scenario.otherCustomerUid,
      paymentReference: scenario.paymentReference,
    });
    const snapshotsAfter = await Promise.all([
      scenario.refs.card.get(),
      scenario.refs.merchantAccount.get(),
      scenario.refs.intent.get(),
      scenario.refs.transaction.get(),
    ]);

    assert.equal(original.outcome, PAYMENT_INTENT_OUTCOMES.FOUND);
    assert.equal(original.payment.status, PAYMENT_INTENT_STATUS.SUCCESS);
    assert.deepEqual(repeated.payment, original.payment);
    assert.equal(
      otherCustomer.outcome,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND,
    );
    for (let index = 0; index < snapshotsBefore.length; index += 1) {
      assert.equal(
        snapshotsAfter[index].updateTime.toMillis(),
        snapshotsBefore[index].updateTime.toMillis(),
      );
    }

    await scenario.refs.transaction.delete();
    const missingLedger = await statusService.getPaymentStatus({
      uid: scenario.customerUid,
      paymentReference: scenario.paymentReference,
    });
    assert.equal(
      missingLedger.outcome,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT,
    );

    await scenario.refs.transaction.set({
      type: 'QR_PAYMENT',
      paymentReference: scenario.paymentReference,
      customerUid: scenario.customerUid,
      merchantUid: scenario.merchantUid,
      amountMinor: 1,
      currency: 'LKR',
      status: PAYMENT_INTENT_STATUS.SUCCESS,
      createdAt: NOW,
    });
    const inconsistentLedger = await statusService.getPaymentStatus({
      uid: scenario.customerUid,
      paymentReference: scenario.paymentReference,
    });
    assert.equal(
      inconsistentLedger.outcome,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT,
    );
  });
});
