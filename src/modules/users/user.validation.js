const ALLOWED_ROLES = new Set(['CUSTOMER', 'MERCHANT']);
const ALLOWED_BUSINESS_CATEGORIES = new Set([
  'Retail',
  'Food & Beverage',
  'Services',
  'Healthcare',
  'Education',
  'Other',
]);

const COMMON_FIELDS = ['name', 'phone'];
const MERCHANT_FIELDS = [
  'businessName',
  'businessCategory',
  'businessAddress',
];

function normalizeSriLankanMobileNumber(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const compactNumber = value.trim().replace(/[\s-]/g, '');

  if (/^07\d{8}$/.test(compactNumber)) {
    return `+94${compactNumber.slice(1)}`;
  }

  if (/^\+947\d{8}$/.test(compactNumber)) {
    return compactNumber;
  }

  return null;
}

function validateField(field, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    const labels = {
      name: 'Full name',
      phone: 'Phone number',
      businessName: 'Business name',
      businessCategory: 'Business category',
      businessAddress: 'Business address',
    };
    return { error: `${labels[field]} is required` };
  }

  const trimmed = value.trim();
  if (field === 'name') {
    return trimmed.length < 2 || trimmed.length > 80
      ? { error: 'Full name must be between 2 and 80 characters' }
      : { value: trimmed };
  }
  if (field === 'phone') {
    const normalizedPhone = normalizeSriLankanMobileNumber(value);
    return normalizedPhone
      ? { value: normalizedPhone }
      : { error: 'Enter a valid Sri Lankan mobile number' };
  }
  if (field === 'businessName') {
    return trimmed.length < 2 || trimmed.length > 100
      ? { error: 'Business name must be between 2 and 100 characters' }
      : { value: trimmed };
  }
  if (field === 'businessCategory') {
    return ALLOWED_BUSINESS_CATEGORIES.has(value)
      ? { value }
      : { error: 'Invalid business category' };
  }
  return trimmed.length < 5 || trimmed.length > 200
    ? { error: 'Business address must be between 5 and 200 characters' }
    : { value: trimmed };
}

function validateBootstrapInput(body) {
  const input = body || {};
  const profile = {};

  for (const field of COMMON_FIELDS) {
    const validation = validateField(field, input[field]);
    if (validation.error) return validation;
    profile[field] = validation.value;
  }

  if (!ALLOWED_ROLES.has(input.role)) {
    return { error: 'Role must be either CUSTOMER or MERCHANT' };
  }
  profile.role = input.role;

  if (input.role === 'MERCHANT') {
    for (const field of MERCHANT_FIELDS) {
      const validation = validateField(field, input[field]);
      if (validation.error) return validation;
      profile[field] = validation.value;
    }
  }

  return { value: profile };
}

function validateProfileUpdateInput(body, role) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Profile update must be an object' };
  }

  const fields = Object.keys(body);
  if (fields.length === 0) {
    return { error: 'At least one profile field is required' };
  }

  const allowedFields = role === 'MERCHANT'
    ? [...COMMON_FIELDS, ...MERCHANT_FIELDS]
    : COMMON_FIELDS;
  const update = {};

  for (const field of fields) {
    if (!allowedFields.includes(field)) {
      return { error: `Field ${field} cannot be updated` };
    }
    const validation = validateField(field, body[field]);
    if (validation.error) return validation;
    update[field] = validation.value;
  }

  return { value: update };
}

module.exports = {
  ALLOWED_BUSINESS_CATEGORIES,
  normalizeSriLankanMobileNumber,
  validateBootstrapInput,
  validateProfileUpdateInput,
};
