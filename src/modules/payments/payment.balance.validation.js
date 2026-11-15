const MIN_RETAINED_BALANCE_MINOR = 50_000;
const MINOR_UNITS_PER_RUPEE = 100;
const MAX_MINOR_UNIT_ROUNDING_ERROR = 1e-6;

const PAYMENT_BALANCE_VALIDATION_OUTCOMES = Object.freeze({
  VALID: 'VALID',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  MINIMUM_BALANCE_REQUIRED: 'MINIMUM_BALANCE_REQUIRED',
  INVALID_BALANCE_INPUT: 'INVALID_BALANCE_INPUT',
});

function convertRupeesToMinorUnits(balance) {
  if (
    typeof balance !== 'number' ||
    !Number.isFinite(balance) ||
    balance < 0
  ) {
    return null;
  }

  const scaledBalance = balance * MINOR_UNITS_PER_RUPEE;
  const balanceMinor = Math.round(scaledBalance);
  if (
    !Number.isSafeInteger(balanceMinor) ||
    Math.abs(scaledBalance - balanceMinor) >
      MAX_MINOR_UNIT_ROUNDING_ERROR
  ) {
    return null;
  }

  return balanceMinor === 0 ? 0 : balanceMinor;
}

function convertMinorUnitsToRupees(balanceMinor) {
  if (!Number.isSafeInteger(balanceMinor) || balanceMinor < 0) {
    return null;
  }

  return balanceMinor / MINOR_UNITS_PER_RUPEE;
}

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
  convertMinorUnitsToRupees,
  convertRupeesToMinorUnits,
  MAX_MINOR_UNIT_ROUNDING_ERROR,
  MIN_RETAINED_BALANCE_MINOR,
  MINOR_UNITS_PER_RUPEE,
  PAYMENT_BALANCE_VALIDATION_OUTCOMES,
  validatePaymentBalance,
};
