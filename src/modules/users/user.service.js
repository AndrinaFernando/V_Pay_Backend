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

function isMissingOnboardingField(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}

function buildBackfill(existingUser, profile) {
  const backfill = {};
  const commonFields = ['name', 'phone'];
  const merchantFields = [
    'businessName',
    'businessCategory',
    'businessAddress',
  ];
  const fields =
    profile.role === 'MERCHANT'
      ? [...commonFields, ...merchantFields]
      : commonFields;

  for (const field of fields) {
    if (isMissingOnboardingField(existingUser[field])) {
      backfill[field] = profile[field];
    }
  }

  return backfill;
}

async function bootstrapUser({
  uid,
  email,
  name,
  phone,
  role,
  businessName,
  businessCategory,
  businessAddress,
}) {
  const userRef = db.collection('users').doc(uid);
  const cardRef = db.collection('cards').doc(uid);
  const profile = {
    name,
    phone,
    role,
    ...(role === 'MERCHANT' && {
      businessName,
      businessCategory,
      businessAddress,
    }),
  };

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

      const profileCreated = !existingUser;

      if (!existingUser) {
        transaction.set(userRef, {
          ...profile,
          email,
          status: 'ACTIVE',
          createdAt: FieldValue.serverTimestamp(),
          fcmToken: null,
        });
      } else {
        const backfill = buildBackfill(existingUser, profile);

        if (Object.keys(backfill).length > 0) {
          transaction.update(userRef, backfill);
        }
      }

      if (role === 'CUSTOMER' && !cardSnapshot.exists) {
        transaction.set(
          cardRef,
          createInitialVirtualCardData(uid)
        );
      }

      return {
        outcome: profileCreated
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
