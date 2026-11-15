const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createTopupService } = require('../../../src/modules/topups/topup.service');

test('Firestore transaction credits and records a repeated provider result once', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  // Refuse to run this test unless it is explicitly pointed to our local emulator.
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8188');
  const app = initializeApp({ projectId: 'demo-vpay-topup' }, `topup-test-${randomUUID()}`);
  const db = getFirestore(app);
  const uid = `customer_${randomUUID()}`;
  const gateway = {
    requireConfig() {},
    async startCheckout() { return { sessionId: 'rupio_sess_test', checkoutUrl: 'https://checkout.example/session', expiresAt: '2030-01-01T00:00:00Z' }; },
  };
  const service = createTopupService({ db, gateway });
  try {
    await db.collection('users').doc(uid).set({ role: 'CUSTOMER', status: 'ACTIVE' });
    await db.collection('cards').doc(uid).set({ ownerId: uid, balance: 25.5 });
    const created = await service.start({ uid, amount: 100 });
    const paymentId = `payment_${randomUUID()}`;
    const event = { eventId: paymentId, paymentId,
      sessionId: 'rupio_sess_test', clientReference: created.id, requestedAmount: 100,
      amount: 120, currency: 'LKR', status: 'SUCCESS', message: 'Approved' };
    await Promise.all([service.applyEvent(event), service.applyEvent(event), service.applyEvent(event)]);
    const card = (await db.collection('cards').doc(uid).get()).data();
    const receipt = await service.get({ uid, id: created.id, reconcile: false });
    const record = (await db.collection('transactions').doc(`topup_${created.id}`).get()).data();
    assert.equal(card.balance, 145.5);
    assert.equal(receipt.status, 'SUCCESS');
    assert.equal(receipt.amount, 120);
    assert.equal(record.type, 'TOP_UP');
    assert.equal(record.uid, uid);
    assert.equal(record.amount, 120);

    const topupBeforeReplay = (await db.collection('topups').doc(created.id).get()).data();
    const transactionsBeforeReplay = await db.collection('transactions').where('topupId', '==', created.id).get();
    assert.equal(transactionsBeforeReplay.size, 1);
    assert.equal((await service.applyEvent(event)).status, 'SUCCESS');
    await assert.rejects(service.applyEvent({ ...event, status: 'FAILED' }), { status: 409 });
    await assert.rejects(service.applyEvent({ ...event, amount: 121 }), { status: 409 });
    assert.equal((await db.collection('cards').doc(uid).get()).data().balance, 145.5);
    assert.deepEqual((await db.collection('topups').doc(created.id).get()).data(), topupBeforeReplay);
    assert.deepEqual((await db.collection('transactions').doc(`topup_${created.id}`).get()).data(), record);
    assert.equal((await db.collection('transactions').where('topupId', '==', created.id).get()).size, 1);

    for (const status of ['FAILED', 'CANCELLED', 'TIMEOUT']) {
      const attempt = await service.start({ uid, amount: 50 });
      const id = `payment_${randomUUID()}`;
      await service.applyEvent({ ...event, eventId: id, paymentId: id,
        clientReference: attempt.id, requestedAmount: 50, amount: 50, status });
      const result = await service.get({ uid, id: attempt.id, reconcile: false });
      assert.equal(result.status, status);
      assert.equal((await db.collection('cards').doc(uid).get()).data().balance, 145.5);
      assert.equal((await db.collection('transactions').doc(`topup_${attempt.id}`).get()).exists, false);
    }

    const pending = await service.start({ uid, amount: 70 });
    const badId = `payment_${randomUUID()}`;
    await assert.rejects(service.applyEvent({ ...event, eventId: badId, paymentId: badId,
      clientReference: pending.id, requestedAmount: 70, currency: 'USD' }));
    assert.equal((await service.get({ uid, id: pending.id, reconcile: false })).status, 'PENDING');
    assert.equal((await db.collection('cards').doc(uid).get()).data().balance, 145.5);
    await assert.rejects(service.get({ uid: 'somebody-else', id: pending.id, reconcile: false }), /not found/);
  } finally {
    await deleteApp(app);
  }
});
