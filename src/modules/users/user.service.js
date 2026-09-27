const { FieldValue } = require('firebase-admin/firestore');

const { db } = require('../../config/firebase');
const {
  createInitialVirtualCardData,
} = require('../cards/card.service');

const BOOTSTRAP_OUTCOMES = {
  CREATED: 'CREATED',
  EXISTING: 'EXISTING',
  ROLE_CONFLICT: 'ROLE_CONFLICT',
};

async function bootstrapUser({ uid, email, name, role }) {
  const userRef = db.collection('users').doc(uid);
  const cardRef = db.collection('cards').doc(uid);

  const transactionResult = await db.runTransaction(
    async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      const existingUser = userSnapshot.exists
        ? userSnapshot.data()
        : null;

      if (existingUser && existingUser.role !== role) {
        return {
          outcome: BOOTSTRAP_OUTCOMES.ROLE_CONFLICT,
        };
      }

      let cardSnapshot = null;

      if (role === 'CUSTOMER') {
        cardSnapshot = await transaction.get(cardRef);
      }

      let created = false;

      if (!existingUser) {
        transaction.set(userRef, {
          name,
          email,
          role,
          status: 'ACTIVE',
          createdAt: FieldValue.serverTimestamp(),
          fcmToken: null,
        });
        created = true;
      }

      if (role === 'CUSTOMER' && !cardSnapshot.exists) {
        transaction.set(
          cardRef,
          createInitialVirtualCardData(uid)
        );
        created = true;
      }

      return {
        outcome: created
          ? BOOTSTRAP_OUTCOMES.CREATED
          : BOOTSTRAP_OUTCOMES.EXISTING,
      };
    }
  );

  if (
    transactionResult.outcome ===
    BOOTSTRAP_OUTCOMES.ROLE_CONFLICT
  ) {
    return transactionResult;
  }

  const userSnapshot = await userRef.get();
  const cardSnapshot =
    role === 'CUSTOMER' ? await cardRef.get() : null;

  return {
    outcome: transactionResult.outcome,
    user: userSnapshot.data(),
    card: cardSnapshot ? cardSnapshot.data() : null,
  };
}

async function getUserByUid(uid) {
  const userSnapshot = await db.collection('users').doc(uid).get();

  if (!userSnapshot.exists) {
    return null;
  }

  return {
    ...userSnapshot.data(),
    uid: userSnapshot.id,
  };
}

module.exports = {
  BOOTSTRAP_OUTCOMES,
  bootstrapUser,
  getUserByUid,
};
