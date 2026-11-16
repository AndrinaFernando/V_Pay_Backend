const PAYMENT_CURRENCY = 'LKR';

const MERCHANT_BALANCE_OUTCOMES = Object.freeze({
  FOUND: 'FOUND',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  ROLE_FORBIDDEN: 'ROLE_FORBIDDEN',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  WALLET_UNAVAILABLE: 'WALLET_UNAVAILABLE',
  INVALID_WALLET: 'INVALID_WALLET',
});

function createMerchantService({ db }) {
  if (!db) throw new TypeError('Firestore database is required');

  async function getBalance({ uid }) {
    const userSnapshot = await db.collection('users').doc(uid).get();
    if (!userSnapshot.exists) {
      return { outcome: MERCHANT_BALANCE_OUTCOMES.PROFILE_NOT_FOUND };
    }

    const user = userSnapshot.data();
    if (user.role !== 'MERCHANT' || user.status !== 'ACTIVE') {
      return { outcome: MERCHANT_BALANCE_OUTCOMES.ROLE_FORBIDDEN };
    }

    const walletSnapshot = await db
      .collection('merchantAccounts')
      .doc(uid)
      .get();
    if (!walletSnapshot.exists) {
      return { outcome: MERCHANT_BALANCE_OUTCOMES.WALLET_NOT_FOUND };
    }

    const wallet = walletSnapshot.data();
    if (wallet.status !== 'ACTIVE' || wallet.currency !== PAYMENT_CURRENCY) {
      return { outcome: MERCHANT_BALANCE_OUTCOMES.WALLET_UNAVAILABLE };
    }
    if (!Number.isSafeInteger(wallet.balanceMinor) || wallet.balanceMinor < 0) {
      return { outcome: MERCHANT_BALANCE_OUTCOMES.INVALID_WALLET };
    }

    return {
      outcome: MERCHANT_BALANCE_OUTCOMES.FOUND,
      balance: {
        balanceMinor: wallet.balanceMinor,
        currency: PAYMENT_CURRENCY,
      },
    };
  }

  return { getBalance };
}

module.exports = {
  MERCHANT_BALANCE_OUTCOMES,
  createMerchantService,
};
