const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_PAYMENT_AMOUNT_MINOR,
  PAYMENT_AMOUNT_VALIDATION_OUTCOMES,
  validatePaymentAmount,
} = require('../../../src/modules/payments/payment.amount.validation');
const {
  DEFAULT_MAX_PAYMENT_AMOUNT_MINOR,
  getMaximumPaymentAmountMinor,
} = require('../../../src/modules/payments/payment.limit.provider');

const { VALID } = PAYMENT_AMOUNT_VALIDATION_OUTCOMES;

test('validates the configured QR payment boundaries in integer minor units', () => {
  const cases = [
    [500, PAYMENT_AMOUNT_VALIDATION_OUTCOMES.PAYMENT_BELOW_MINIMUM],
    [1_000, VALID],
    [500_000, VALID],
    [2_000_000, VALID],
    [2_000_001, PAYMENT_AMOUNT_VALIDATION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED],
    [2_500_000, PAYMENT_AMOUNT_VALIDATION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED],
  ];

  for (const [amountMinor, outcome] of cases) {
    assert.equal(
      validatePaymentAmount(
        amountMinor,
        DEFAULT_MAX_PAYMENT_AMOUNT_MINOR,
      ).outcome,
      outcome,
    );
  }
  assert.equal(MIN_PAYMENT_AMOUNT_MINOR, 1_000);
});

test('rejects malformed amounts and malformed trusted limits', () => {
  for (const amountMinor of [undefined, null, '1000', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      validatePaymentAmount(amountMinor, 2_000_000).outcome,
      PAYMENT_AMOUNT_VALIDATION_OUTCOMES.INVALID_PAYMENT_AMOUNT,
    );
  }

  for (const limitMinor of [undefined, null, '2000000', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      validatePaymentAmount(1_000, limitMinor).outcome,
      PAYMENT_AMOUNT_VALIDATION_OUTCOMES.INVALID_PAYMENT_LIMIT,
    );
  }
});

test('uses a separately supplied trusted limit without coupling validation to policy', () => {
  assert.equal(validatePaymentAmount(5_000, 5_000).outcome, VALID);
  assert.equal(
    validatePaymentAmount(5_001, 5_000).outcome,
    PAYMENT_AMOUNT_VALIDATION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED,
  );
});

test('fixed provider ignores request-shaped limit data', async () => {
  const result = await getMaximumPaymentAmountMinor({
    customerUid: 'customer1',
    customerProfile: { role: 'CUSTOMER', status: 'ACTIVE' },
    amountMinor: 1,
    maxLimitMinor: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(result, DEFAULT_MAX_PAYMENT_AMOUNT_MINOR);
});
