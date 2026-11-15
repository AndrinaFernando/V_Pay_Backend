const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertMinorUnitsToRupees,
  convertRupeesToMinorUnits,
  MIN_RETAINED_BALANCE_MINOR,
  PAYMENT_BALANCE_VALIDATION_OUTCOMES,
  validatePaymentBalance,
} = require('../../../src/modules/payments/payment.balance.validation');

const {
  INSUFFICIENT_BALANCE,
  INVALID_BALANCE_INPUT,
  MINIMUM_BALANCE_REQUIRED,
  VALID,
} = PAYMENT_BALANCE_VALIDATION_OUTCOMES;

test('converts valid rupee balances to exact integer minor units', () => {
  const cases = [
    [0, 0],
    [500, 50_000],
    [1_000.55, 100_055],
    [0.1 + 0.2, 30],
    [19.99 + 0.01, 2_000],
  ];

  for (const [balance, expectedMinor] of cases) {
    assert.equal(convertRupeesToMinorUnits(balance), expectedMinor);
    assert.equal(
      convertMinorUnitsToRupees(expectedMinor),
      expectedMinor / 100,
    );
  }
});

test('rejects non-finite, unsafe, negative, and fractional-cent balances', () => {
  for (const balance of [
    NaN,
    Infinity,
    -1,
    0.001,
    12.345,
    500.000_001,
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.equal(convertRupeesToMinorUnits(balance), null);
  }

  for (const balanceMinor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(convertMinorUnitsToRupees(balanceMinor), null);
  }
});

test('enforces the Rs. 500 retained balance at exact integer boundaries', () => {
  const cases = [
    [200_000, 100_000, VALID, 100_000],
    [200_000, 150_000, VALID, 50_000],
    [200_000, 150_100, MINIMUM_BALANCE_REQUIRED],
    [50_000, 1_000, MINIMUM_BALANCE_REQUIRED],
    [51_000, 1_000, VALID, 50_000],
    [40_000, 1_000, MINIMUM_BALANCE_REQUIRED],
    [10_000, 20_000, INSUFFICIENT_BALANCE],
  ];

  for (const [balanceMinor, amountMinor, outcome, resultingBalanceMinor] of cases) {
    assert.deepEqual(
      validatePaymentBalance(
        balanceMinor,
        amountMinor,
        MIN_RETAINED_BALANCE_MINOR,
      ),
      resultingBalanceMinor === undefined
        ? { outcome }
        : { outcome, resultingBalanceMinor },
    );
  }
  assert.equal(MIN_RETAINED_BALANCE_MINOR, 50_000);
});

test('rejects invalid monetary inputs without performing arithmetic', () => {
  const invalidCases = [
    [-1, 1_000, 50_000],
    [1.5, 1_000, 50_000],
    [Number.MAX_SAFE_INTEGER + 1, 1_000, 50_000],
    [100_000, 0, 50_000],
    [100_000, -1, 50_000],
    [100_000, 1.5, 50_000],
    [100_000, Number.MAX_SAFE_INTEGER + 1, 50_000],
    [100_000, 1_000, -1],
    [100_000, 1_000, 1.5],
    [100_000, 1_000, Number.MAX_SAFE_INTEGER + 1],
    [null, 1_000, 50_000],
    [100_000, '1000', 50_000],
    [100_000, 1_000, '50000'],
  ];

  for (const values of invalidCases) {
    assert.equal(
      validatePaymentBalance(...values).outcome,
      INVALID_BALANCE_INPUT,
    );
  }
});
