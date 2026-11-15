const PAYMENT_CURRENCY = 'LKR';
const DEFAULT_EXPIRY_SECONDS = 15 * 60;
const MIN_EXPIRY_SECONDS = 60;
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;
const MAX_DESCRIPTION_LENGTH = 200;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

const ALLOWED_FIELDS = new Set([
  'amountMinor',
  'currency',
  'description',
  'expiresInSeconds',
]);

function validateCreatePaymentIntentInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }

  const unexpectedField = Object.keys(body).find(
    (field) => !ALLOWED_FIELDS.has(field)
  );
  if (unexpectedField) {
    return { error: `Unexpected field: ${unexpectedField}` };
  }

  const { amountMinor, currency, description, expiresInSeconds } = body;

  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return { error: 'amountMinor must be a positive safe integer' };
  }

  if (currency !== PAYMENT_CURRENCY) {
    return { error: `currency must be ${PAYMENT_CURRENCY}` };
  }

  let normalizedDescription;
  if (description !== undefined) {
    if (typeof description !== 'string') {
      return { error: 'description must be a string' };
    }

    normalizedDescription = description.trim();
    if (normalizedDescription.length > MAX_DESCRIPTION_LENGTH) {
      return {
        error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
      };
    }
    if (!normalizedDescription) normalizedDescription = undefined;
  }

  const expiry = expiresInSeconds === undefined
    ? DEFAULT_EXPIRY_SECONDS
    : expiresInSeconds;
  if (
    !Number.isSafeInteger(expiry) ||
    expiry < MIN_EXPIRY_SECONDS ||
    expiry > MAX_EXPIRY_SECONDS
  ) {
    return {
      error: `expiresInSeconds must be an integer from ${MIN_EXPIRY_SECONDS} to ${MAX_EXPIRY_SECONDS}`,
    };
  }

  return {
    value: {
      amountMinor,
      currency: PAYMENT_CURRENCY,
      ...(normalizedDescription && { description: normalizedDescription }),
      expiresInSeconds: expiry,
    },
  };
}

function validateListPaymentIntentsQuery(query) {
  const rawLimit = query?.limit;
  if (rawLimit === undefined) {
    return { value: { limit: DEFAULT_LIST_LIMIT } };
  }

  if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
    return { error: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}` };
  }

  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    return { error: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}` };
  }

  return { value: { limit } };
}

module.exports = {
  DEFAULT_LIST_LIMIT,
  DEFAULT_EXPIRY_SECONDS,
  MAX_DESCRIPTION_LENGTH,
  MAX_EXPIRY_SECONDS,
  MAX_LIST_LIMIT,
  MIN_EXPIRY_SECONDS,
  PAYMENT_CURRENCY,
  validateCreatePaymentIntentInput,
  validateListPaymentIntentsQuery,
};
