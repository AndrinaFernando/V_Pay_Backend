const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_EXPIRY_SECONDS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_PAYMENT_AMOUNT_LIMITS,
  MAX_DESCRIPTION_LENGTH,
  MAX_EXPIRY_SECONDS,
  MAX_LIST_LIMIT,
  MIN_EXPIRY_SECONDS,
  validateConfirmPaymentIntentInput,
  validateCreatePaymentIntentInput,
  validateListCustomerTransactionsQuery,
  validateListPaymentIntentsQuery,
} = require('../../../src/modules/payments/payment.validation');

test('accepts valid input, trims description, and applies default expiry', () => {
  const result = validateCreatePaymentIntentInput({
    amountMinor: 125000,
    currency: 'LKR',
    description: '  Order 123  ',
  });

  assert.deepEqual(result, {
    value: {
      amountMinor: 125000,
      currency: 'LKR',
      description: 'Order 123',
      expiresInSeconds: DEFAULT_EXPIRY_SECONDS,
    },
  });
});

test('accepts LKR amount limits inclusively and allows injected merchant policy', () => {
  for (const amountMinor of [
    DEFAULT_PAYMENT_AMOUNT_LIMITS.minimumMinor,
    DEFAULT_PAYMENT_AMOUNT_LIMITS.maximumMinor,
  ]) {
    assert.equal(
      validateCreatePaymentIntentInput({ amountMinor, currency: 'LKR' }).value
        .amountMinor,
      amountMinor,
    );
  }

  const merchantPolicy = { minimumMinor: 2500, maximumMinor: 500000 };
  assert.equal(
    validateCreatePaymentIntentInput(
      { amountMinor: 2500, currency: 'LKR' },
      merchantPolicy,
    ).value.amountMinor,
    2500,
  );
  assert.match(
    validateCreatePaymentIntentInput(
      { amountMinor: 1000, currency: 'LKR' },
      merchantPolicy,
    ).error,
    /amountMinor/,
  );
});

test('rejects amounts below LKR 10 and above LKR 100,000', () => {
  for (const amountMinor of [
    DEFAULT_PAYMENT_AMOUNT_LIMITS.minimumMinor - 1,
    DEFAULT_PAYMENT_AMOUNT_LIMITS.maximumMinor + 1,
  ]) {
    assert.match(
      validateCreatePaymentIntentInput({ amountMinor, currency: 'LKR' }).error,
      /amountMinor/,
    );
  }
});

test('accepts expiry at both configured boundaries', () => {
  for (const expiresInSeconds of [MIN_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS]) {
    const result = validateCreatePaymentIntentInput({
      amountMinor: DEFAULT_PAYMENT_AMOUNT_LIMITS.minimumMinor,
      currency: 'LKR',
      expiresInSeconds,
    });
    assert.equal(result.value.expiresInSeconds, expiresInSeconds);
  }
});

test('rejects missing, fractional, non-positive, and unsafe amounts', () => {
  for (const amountMinor of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = validateCreatePaymentIntentInput({
      amountMinor,
      currency: 'LKR',
    });
    assert.match(result.error, /amountMinor/);
  }
});

test('rejects non-LKR currency', () => {
  const result = validateCreatePaymentIntentInput({
    amountMinor: DEFAULT_PAYMENT_AMOUNT_LIMITS.minimumMinor,
    currency: 'USD',
  });
  assert.match(result.error, /currency/);
});

test('rejects non-string and overlong descriptions', () => {
  for (const description of [42, 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1)]) {
    const result = validateCreatePaymentIntentInput({
      amountMinor: DEFAULT_PAYMENT_AMOUNT_LIMITS.minimumMinor,
      currency: 'LKR',
      description,
    });
    assert.match(result.error, /description/);
  }
});

test('rejects expiry outside the configured range or not an integer', () => {
  for (const expiresInSeconds of [
    null,
    MIN_EXPIRY_SECONDS - 1,
    MAX_EXPIRY_SECONDS + 1,
    1.5,
  ]) {
    const result = validateCreatePaymentIntentInput({
      amountMinor: DEFAULT_PAYMENT_AMOUNT_LIMITS.minimumMinor,
      currency: 'LKR',
      expiresInSeconds,
    });
    assert.match(result.error, /expiresInSeconds/);
  }
});

test('rejects client-supplied ownership, status, and expiry timestamp fields', () => {
  for (const field of ['merchantUid', 'status', 'expiresAt']) {
    const result = validateCreatePaymentIntentInput({
      amountMinor: DEFAULT_PAYMENT_AMOUNT_LIMITS.minimumMinor,
      currency: 'LKR',
      [field]: 'client-controlled',
    });
    assert.match(result.error, /Unexpected field/);
  }
});

test('validates recent-intent list limit and applies its default', () => {
  assert.deepEqual(validateListPaymentIntentsQuery({}), {
    value: { limit: DEFAULT_LIST_LIMIT },
  });
  assert.deepEqual(validateListPaymentIntentsQuery({ limit: '5' }), {
    value: { limit: 5 },
  });
  assert.deepEqual(validateListPaymentIntentsQuery({ limit: String(MAX_LIST_LIMIT) }), {
    value: { limit: MAX_LIST_LIMIT },
  });

  for (const limit of ['0', '-1', '1.5', 'abc', String(MAX_LIST_LIMIT + 1)]) {
    assert.match(validateListPaymentIntentsQuery({ limit }).error, /limit/);
  }
});

test('validates customer transaction history limits', () => {
  assert.deepEqual(validateListCustomerTransactionsQuery({}), {
    value: { limit: DEFAULT_LIST_LIMIT },
  });
  assert.deepEqual(validateListCustomerTransactionsQuery({ limit: '50' }), {
    value: { limit: 50 },
  });

  for (const limit of ['0', '51', '-1', '1.5', 'abc']) {
    assert.match(
      validateListCustomerTransactionsQuery({ limit }).error,
      /limit/,
    );
  }
});

test('supports an omitted or empty confirmation body and rejects explicit null', () => {
  assert.deepEqual(validateConfirmPaymentIntentInput(undefined), {
    value: {},
  });
  assert.deepEqual(validateConfirmPaymentIntentInput({}), {
    value: {},
  });
  assert.match(
    validateConfirmPaymentIntentInput(null).error,
    /empty JSON object/,
  );

  for (const body of [
    { amountMinor: 100 },
    { currency: 'LKR' },
    { merchantUid: 'merchant1' },
    { customerUid: 'customer1' },
    { status: 'SUCCESS' },
    [],
  ]) {
    assert.match(validateConfirmPaymentIntentInput(body).error, /body|payment data/);
  }
});
