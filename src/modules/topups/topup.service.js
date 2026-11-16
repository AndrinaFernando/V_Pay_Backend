const crypto = require('node:crypto');
const { deliverBestEffort } = require('../notifications/notification.delivery');

const FINAL = new Set(['SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT']);
const validAmount = value => Number.isSafeInteger(value) && value > 0 && value <= 1000000;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
function iso(value) {
  if (!value) return null;
  const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function publicTopup(id, data) {
  return { id, status: data.status, requestedAmount: data.requestedAmount, amount: data.amount ?? null,
    currency: data.currency, message: data.message ?? null, checkoutUrl: data.checkoutUrl ?? null,
    createdAt: iso(data.createdAt), expiresAt: iso(data.expiresAt), completedAt: iso(data.completedAt) };
}

function createTopupService({ db, gateway, now = () => new Date(), notifications = { notifyTopUpSuccess: async () => {} } }) {
  async function start({ uid, amount }) {
    if (!validAmount(amount)) throw fail('Enter a whole number of rupees from 1 to 1,000,000.');
    gateway.requireConfig();
    if (gateway.verifyEndpoint) await gateway.verifyEndpoint();
    const userRef = db.collection('users').doc(uid);
    const cardRef = db.collection('cards').doc(uid);
    const topupRef = db.collection('topups').doc();
    const data = { uid, requestedAmount: amount, currency: 'LKR', status: 'CREATING', createdAt: now(), updatedAt: now() };
    await db.runTransaction(async tx => {
      const user = await tx.get(userRef);
      const card = await tx.get(cardRef);
      if (!user.exists || user.data().role !== 'CUSTOMER' || user.data().status !== 'ACTIVE') throw fail('An active customer account is required.', 403);
      if (!card.exists || card.data().ownerId !== uid) throw fail('Customer card not found.', 404);
      tx.create(topupRef, data);
    });
    try {
      const session = await gateway.startCheckout({ reference: topupRef.id, uid, amount });
      await db.runTransaction(async tx => {
        const snapshot = await tx.get(topupRef);
        if (!snapshot.exists || snapshot.data().status !== 'CREATING') throw fail('Top-up state changed unexpectedly.', 409);
        tx.update(topupRef, { status: 'PENDING', sessionId: session.sessionId, checkoutUrl: session.checkoutUrl,
          expiresAt: new Date(session.expiresAt), updatedAt: now() });
      });
      return publicTopup(topupRef.id, { ...data, status: 'PENDING', ...session, expiresAt: new Date(session.expiresAt) });
    } catch (error) {
      // A network failure is ambiguous; only documented validation/auth rejection is definite.
      const rejected = error.definiteRejection === true;
      await db.runTransaction(async tx => {
        const snapshot = await tx.get(topupRef);
        if (snapshot.exists && snapshot.data().status === 'CREATING') {
          tx.update(topupRef, { status: rejected ? 'START_FAILED' : 'START_UNKNOWN',
            message: rejected ? 'Rupio rejected the checkout. Check the amount and staging settings.' : 'Checkout could not be confirmed. Contact support before retrying.', updatedAt: now() });
        }
      });
      throw fail(rejected ? 'Rupio rejected the checkout. Check the amount and staging settings.' : 'Checkout could not be confirmed. Check your top-up history before retrying.', 502);
    }
  }

  async function applyEvent(event) {
    if (!event || !validId(event.clientReference) || !validId(event.sessionId) || !validId(event.paymentId) || !validId(event.eventId) ||
        !FINAL.has(event.status) || event.currency !== 'LKR' || !validAmount(event.requestedAmount) || !validAmount(event.amount) ||
        typeof event.message !== 'string' || event.message.length > 500) throw fail('Invalid Rupio result.');
    const topupRef = db.collection('topups').doc(event.clientReference);
    const eventKey = crypto.createHash('sha256').update(event.eventId).digest('hex');
    const eventRef = db.collection('rupioEvents').doc(eventKey);
    const transactionRef = db.collection('transactions').doc(`topup_${event.clientReference}`);
    const result = await db.runTransaction(async tx => {
      const topup = await tx.get(topupRef);
      const seen = await tx.get(eventRef);
      if (!topup.exists) throw fail('Top-up not found.', 404);
      const current = topup.data();
      if (!current.sessionId) throw fail('Checkout is still being registered. Retry callback.', 503);
      if (current.sessionId !== event.sessionId || current.requestedAmount !== event.requestedAmount || current.currency !== event.currency) throw fail('Rupio result does not match the top-up.', 409);
      if (seen.exists) {
        if (seen.data().topupId !== event.clientReference || seen.data().paymentId !== event.paymentId) throw fail('Conflicting event identifier.', 409);
        if (current.paymentId !== event.paymentId || current.status !== event.status || current.amount !== event.amount) throw fail('Top-up already has a different final result.', 409);
        return publicTopup(topupRef.id, current);
      }
      if (FINAL.has(current.status)) {
        if (current.paymentId === event.paymentId && current.status === event.status && current.amount === event.amount) return publicTopup(topupRef.id, current);
        throw fail('Top-up already has a different final result.', 409);
      }
      if (current.status !== 'PENDING') throw fail('Top-up is not ready for a result.', 409);
      const cardRef = db.collection('cards').doc(current.uid);
      const card = event.status === 'SUCCESS' ? await tx.get(cardRef) : null;
      if (card && (!card.exists || card.data().ownerId !== current.uid || typeof card.data().balance !== 'number' || !Number.isFinite(card.data().balance))) throw fail('Customer card is unavailable.', 409);
      const completedAt = now();
      const update = { status: event.status, amount: event.amount, paymentId: event.paymentId, message: event.message, completedAt, updatedAt: completedAt };
      if (card) {
        const minor = Math.round(card.data().balance * 100);
        if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(minor + event.amount * 100)) throw fail('Invalid card balance.', 409);
        tx.update(cardRef, { balance: (minor + event.amount * 100) / 100 });
        tx.create(transactionRef, { type: 'TOP_UP', uid: current.uid, cardId: current.uid, topupId: topupRef.id,
          amount: event.amount, currency: 'LKR', status: 'SUCCESS', provider: 'RUPIO', providerPaymentId: event.paymentId, createdAt: completedAt });
      }
      tx.create(eventRef, { topupId: topupRef.id, paymentId: event.paymentId, createdAt: completedAt });
      tx.update(topupRef, update);
      return { ...publicTopup(topupRef.id, { ...current, ...update }),
        notificationUid: event.status === 'SUCCESS' ? current.uid : null };
    });
    const { notificationUid, ...topup } = result;
    if (notificationUid) {
      await deliverBestEffort([() => notifications.notifyTopUpSuccess(notificationUid)]);
    }
    return topup;
  }

  async function get({ uid, id, reconcile = true }) {
    if (!validId(id)) throw fail('Top-up not found.', 404);
    const ref = db.collection('topups').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.data().uid !== uid) throw fail('Top-up not found.', 404);
    const current = snapshot.data();
    if (reconcile && current.status === 'PENDING' && current.sessionId) {
      try {
        const session = await gateway.getSession(current.sessionId);
        if (session && session.sessionId === current.sessionId && session.clientReference === id && FINAL.has(session.status) && validId(session.paymentId)) {
          const payment = await gateway.getPayment(session.paymentId);
          if (!payment || payment.paymentId !== session.paymentId || payment.sessionId !== session.sessionId || payment.status !== session.status || payment.amount !== session.amount || payment.currency !== session.currency) throw fail('Rupio status mismatch.', 409);
          return await applyEvent({ ...payment, eventId: payment.paymentId });
        }
      } catch (error) {
        // A failed status check is not evidence of payment failure; a signed callback can still arrive.
        console.warn('Rupio reconciliation unavailable:', error.message);
      }
    }
    return publicTopup(id, current);
  }

  async function list({ uid }) {
    const snapshot = await db.collection('topups').where('uid', '==', uid).get();
    return snapshot.docs.map(doc => publicTopup(doc.id, doc.data())).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 100);
  }
  return { start, applyEvent, get, list };
}

function defaultService() {
  return createTopupService({ db: require('../../config/firebase').db, gateway: require('./rupio.adapter').defaultAdapter(),
    notifications: require('../notifications/notification.service') });
}
module.exports = { createTopupService, defaultService, validAmount };
