const MIN_PAYMENT_AMOUNT_MINOR = 1_000;

const PAYMENT_AMOUNT_VALIDATION_OUTCOMES = Object.freeze({
  VALID: 'VALID',
  INVALID_PAYMENT_AMOUNT: 'INVALID_PAYMENT_AMOUNT',
  INVALID_PAYMENT_LIMIT: 'INVALID_PAYMENT_LIMIT',
  PAYMENT_BELOW_MINIMUM: 'PAYMENT_BELOW_MINIMUM',
  PAYMENT_LIMIT_EXCEEDED: 'PAYMENT_LIMIT_EXCEEDED',
});

function validatePaymentAmount(amountMinor, maxLimitMinor) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return {
      outcome: PAYMENT_AMOUNT_VALIDATION_OUTCOMES.INVALID_PAYMENT_AMOUNT,
    };
  }

  if (!Number.isSafeInteger(maxLimitMinor) || maxLimitMinor <= 0) {
    return {
      outcome: PAYMENT_AMOUNT_VALIDATION_OUTCOMES.INVALID_PAYMENT_LIMIT,
    };
  }

  if (amountMinor < MIN_PAYMENT_AMOUNT_MINOR) {
    return {
      outcome: PAYMENT_AMOUNT_VALIDATION_OUTCOMES.PAYMENT_BELOW_MINIMUM,
    };
  }

  if (amountMinor > maxLimitMinor) {
    return {
      outcome: PAYMENT_AMOUNT_VALIDATION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED,
    };
  }

  return { outcome: PAYMENT_AMOUNT_VALIDATION_OUTCOMES.VALID };
}

module.exports = {
  MIN_PAYMENT_AMOUNT_MINOR,
  PAYMENT_AMOUNT_VALIDATION_OUTCOMES,
  validatePaymentAmount,
};
