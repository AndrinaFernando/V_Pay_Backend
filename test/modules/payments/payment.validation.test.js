const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_EXPIRY_SECONDS,
  DEFAULT_LIST_LIMIT,
  MAX_DESCRIPTION_LENGTH,
  MAX_EXPIRY_SECONDS,
  MAX_LIST_LIMIT,
  MIN_EXPIRY_SECONDS,
  validateCreatePaymentIntentInput,
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

test('accepts expiry at both configured boundaries', () => {
  for (const expiresInSeconds of [MIN_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS]) {
    const result = validateCreatePaymentIntentInput({
      amountMinor: 1,
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
    amountMinor: 100,
    currency: 'USD',
  });
  assert.match(result.error, /currency/);
});

test('rejects non-string and overlong descriptions', () => {
  for (const description of [42, 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1)]) {
    const result = validateCreatePaymentIntentInput({
      amountMinor: 100,
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
      amountMinor: 100,
      currency: 'LKR',
      expiresInSeconds,
    });
    assert.match(result.error, /expiresInSeconds/);
  }
});

test('rejects client-supplied ownership, status, and expiry timestamp fields', () => {
  for (const field of ['merchantUid', 'status', 'expiresAt']) {
    const result = validateCreatePaymentIntentInput({
      amountMinor: 100,
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
