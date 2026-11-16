const { createHash, randomUUID } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');

const TYPES = new Set(['TOP_UP_SUCCESS', 'PAYMENT_SUCCESS', 'PAYMENT_RECEIVED']);

function validUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && uid.trim() === uid && !uid.includes('/');
}

// Tokens are opaque. These are local input limits, not a claim of FCM validity.
function validToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[^\x21-\x7e]/.test(token);
}

function validBindingId(bindingId) {
  return typeof bindingId === 'string' && bindingId.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(bindingId);
}

function createNotificationService({ db, messaging }) {
  function ownerRef(token) {
    const hash = createHash('sha256').update(token).digest('hex');
    return db.collection('fcmTokenOwners').doc(hash);
  }

  async function sendNotification(input) {
    const { uid, type } = input || {};
    if (!validUid(uid) || !TYPES.has(type)) {
      return { status: 'INVALID_INPUT' };
    }
    let recipient;
    try {
      // Read both documents in one consistent snapshot. Never send in the callback:
      // Firestore can retry it, and ownership may change after this snapshot.
      recipient = await db.runTransaction(async transaction => {
        const user = await transaction.get(db.collection('users').doc(uid));
        if (!user.exists) return { status: 'PROFILE_NOT_FOUND' };
        const token = user.data().fcmToken;
        if (token == null || token === '') return { status: 'MISSING_TOKEN' };
        if (!validToken(token)) return { status: 'INVALID_TOKEN' };
        const owner = (await transaction.get(ownerRef(token))).data();
        if (!owner || owner.uid !== uid || !validBindingId(owner.bindingId)) {
          return { status: 'UNVERIFIED_TOKEN' };
        }
        return { token, bindingId: owner.bindingId };
      });
    } catch {
      return { status: 'PROFILE_READ_FAILED' };
    }
    if (recipient.status) return recipient;
    try {
      // Flutter must verify its active binding before presenting a notification.
      await messaging.send({
        token: recipient.token,
        data: { type, bindingId: recipient.bindingId },
      });
      return { status: 'SENT' };
    } catch (error) {
      if (error?.code === 'messaging/registration-token-not-registered' ||
          error?.code === 'messaging/invalid-registration-token') {
        // The same conditional removal protects a newer registration from a
        // delayed FCM failure. Cleanup failures remain non-throwing as well.
        await unregisterToken({ uid, fcmToken: recipient.token, bindingId: recipient.bindingId });
      }
      // Never expose SDK errors: they can contain registration tokens.
      return { status: 'MESSAGING_FAILED' };
    }
  }

  async function registerToken(input) {
    const { uid, fcmToken } = input || {};
    if (!validUid(uid) || !validToken(fcmToken)) return { status: 'INVALID_INPUT' };
    try {
      const bindingId = randomUUID();
      return await db.runTransaction(async transaction => {
        const userRef = db.collection('users').doc(uid);
        const user = await transaction.get(userRef);
        if (!user.exists) return { status: 'PROFILE_NOT_FOUND' };

        const incomingRef = ownerRef(fcmToken);
        const incomingOwner = (await transaction.get(incomingRef)).data();
        // Fail closed on a corrupt owner UID rather than constructing an unsafe path.
        if (incomingOwner && !validUid(incomingOwner.uid)) return { status: 'TOKEN_UPDATE_FAILED' };

        const previousToken = user.data().fcmToken;
        let previousRef;
        let previousOwner;
        if (validToken(previousToken) && previousToken !== fcmToken) {
          previousRef = ownerRef(previousToken);
          previousOwner = (await transaction.get(previousRef)).data();
        }

        let formerUserRef;
        let formerUser;
        if (incomingOwner && incomingOwner.uid !== uid) {
          formerUserRef = db.collection('users').doc(incomingOwner.uid);
          formerUser = await transaction.get(formerUserRef);
        }

        // All reads precede all writes. Only notification fields are changed.
        if (formerUser?.exists && formerUser.data().fcmToken === fcmToken) {
          transaction.update(formerUserRef, { fcmToken: null });
        }
        if (previousOwner?.uid === uid) transaction.delete(previousRef);
        transaction.update(userRef, { fcmToken });
        transaction.set(incomingRef, { uid, bindingId, updatedAt: FieldValue.serverTimestamp() });
        return { status: 'REGISTERED', bindingId };
      });
    } catch {
      return { status: 'TOKEN_UPDATE_FAILED' };
    }
  }

  async function unregisterToken(input) {
    const { uid, fcmToken, bindingId } = input || {};
    if (!validUid(uid) || !validToken(fcmToken) || !validBindingId(bindingId)) {
      return { status: 'INVALID_INPUT' };
    }
    try {
      return await db.runTransaction(async transaction => {
        const ref = ownerRef(fcmToken);
        const owner = (await transaction.get(ref)).data();
        if (!owner || owner.uid !== uid || owner.bindingId !== bindingId) {
          return { status: 'UNREGISTERED' };
        }
        const userRef = db.collection('users').doc(uid);
        const user = await transaction.get(userRef);
        transaction.delete(ref);
        if (user.exists && user.data().fcmToken === fcmToken) {
          transaction.update(userRef, { fcmToken: null });
        }
        return { status: 'UNREGISTERED' };
      });
    } catch {
      return { status: 'TOKEN_UPDATE_FAILED' };
    }
  }

  return {
    sendNotification,
    notifyTopUpSuccess: (uid) => sendNotification({ uid, type: 'TOP_UP_SUCCESS' }),
    notifyPaymentSuccess: (uid) => sendNotification({ uid, type: 'PAYMENT_SUCCESS' }),
    notifyPaymentReceived: (uid) => sendNotification({ uid, type: 'PAYMENT_RECEIVED' }),
    registerToken,
    unregisterToken,
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
