const MIN_RETAINED_BALANCE_MINOR = 50_000;

const PAYMENT_BALANCE_VALIDATION_OUTCOMES = Object.freeze({
  VALID: 'VALID',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  MINIMUM_BALANCE_REQUIRED: 'MINIMUM_BALANCE_REQUIRED',
  INVALID_BALANCE_INPUT: 'INVALID_BALANCE_INPUT',
});

function validatePaymentBalance(
  balanceMinor,
  paymentAmountMinor,
  minRetainedBalanceMinor,
) {
  if (
    !Number.isSafeInteger(balanceMinor) ||
    balanceMinor < 0 ||
    !Number.isSafeInteger(paymentAmountMinor) ||
    paymentAmountMinor <= 0 ||
    !Number.isSafeInteger(minRetainedBalanceMinor) ||
    minRetainedBalanceMinor < 0
  ) {
    return {
      outcome:
        PAYMENT_BALANCE_VALIDATION_OUTCOMES.INVALID_BALANCE_INPUT,
    };
  }

  if (balanceMinor < paymentAmountMinor) {
    return {
      outcome: PAYMENT_BALANCE_VALIDATION_OUTCOMES.INSUFFICIENT_BALANCE,
    };
  }

  const resultingBalanceMinor = balanceMinor - paymentAmountMinor;
  if (resultingBalanceMinor < minRetainedBalanceMinor) {
    return {
      outcome:
        PAYMENT_BALANCE_VALIDATION_OUTCOMES.MINIMUM_BALANCE_REQUIRED,
    };
  }

  return {
    outcome: PAYMENT_BALANCE_VALIDATION_OUTCOMES.VALID,
    resultingBalanceMinor,
  };
}

module.exports = {
  MIN_RETAINED_BALANCE_MINOR,
  PAYMENT_BALANCE_VALIDATION_OUTCOMES,
  validatePaymentBalance,
};
