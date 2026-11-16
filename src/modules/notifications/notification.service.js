const MESSAGES = Object.freeze({
  TOP_UP_SUCCESS: Object.freeze({ title: 'Top-up successful', body: 'Your VPay top-up was completed successfully.' }),
  PAYMENT_SUCCESS: Object.freeze({ title: 'Payment successful', body: 'Your VPay payment was completed successfully.' }),
  PAYMENT_RECEIVED: Object.freeze({ title: 'Payment received', body: 'You received a payment through VPay.' }),
});

function validUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && uid.trim() === uid && !uid.includes('/');
}

// Tokens are opaque. These are local input limits, not a claim of FCM validity.
function validToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 4096 && /^[\x21-\x7e]+$/.test(token);
}

function createNotificationService({ db, messaging }) {
  async function sendNotification(input) {
    const { uid, type } = input || {};
    if (!validUid(uid) || typeof type !== 'string' || !Object.hasOwn(MESSAGES, type)) {
      return { status: 'INVALID_INPUT' };
    }
    let token;
    try {
      const user = await db.collection('users').doc(uid).get();
      if (!user.exists) return { status: 'PROFILE_NOT_FOUND' };
      token = user.data().fcmToken;
    } catch {
      return { status: 'PROFILE_READ_FAILED' };
    }
    if (token == null || token === '') return { status: 'MISSING_TOKEN' };
    if (!validToken(token)) return { status: 'INVALID_TOKEN' };
    try {
      await messaging.send({ token, notification: { ...MESSAGES[type] }, data: { type } });
      return { status: 'SENT' };
    } catch {
      // Never expose SDK errors: they can contain registration tokens.
      return { status: 'MESSAGING_FAILED' };
    }
  }

  async function registerToken(input) {
    const { uid, fcmToken } = input || {};
    if (!validUid(uid) || !validToken(fcmToken)) return { status: 'INVALID_INPUT' };
    try {
      // update() is atomic, preserves other fields, and cannot create a profile.
      await db.collection('users').doc(uid).update({ fcmToken });
      return { status: 'REGISTERED' };
    } catch (error) {
      if (error.code === 5 || error.code === 'not-found') return { status: 'PROFILE_NOT_FOUND' };
      return { status: 'TOKEN_UPDATE_FAILED' };
    }
  }

  return {
    sendNotification,
    notifyTopUpSuccess: (uid) => sendNotification({ uid, type: 'TOP_UP_SUCCESS' }),
    notifyPaymentSuccess: (uid) => sendNotification({ uid, type: 'PAYMENT_SUCCESS' }),
    notifyPaymentReceived: (uid) => sendNotification({ uid, type: 'PAYMENT_RECEIVED' }),
    registerToken,
  };
}

let service;
function defaultService() {
  if (!service) {
    const { db } = require('../../config/firebase');
    const { getMessaging } = require('firebase-admin/messaging');
    service = createNotificationService({ db, messaging: getMessaging() });
  }
  return service;
}

// Include initialization errors in the same non-throwing notification contract.
async function sendNotification(input) {
  try { return await defaultService().sendNotification(input); }
  catch { return { status: 'SERVICE_UNAVAILABLE' }; }
}

module.exports = {
  createNotificationService,
  defaultService,
  sendNotification,
  notifyTopUpSuccess: (uid) => sendNotification({ uid, type: 'TOP_UP_SUCCESS' }),
  notifyPaymentSuccess: (uid) => sendNotification({ uid, type: 'PAYMENT_SUCCESS' }),
  notifyPaymentReceived: (uid) => sendNotification({ uid, type: 'PAYMENT_RECEIVED' }),
};
