const ALLOWED_ROLES = new Set(['CUSTOMER', 'MERCHANT']);
const ALLOWED_BUSINESS_CATEGORIES = new Set([
  'Retail',
  'Food & Beverage',
  'Services',
  'Healthcare',
  'Education',
  'Other',
]);

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

function validateBootstrapInput(body) {
  const {
    name,
    phone,
    role,
    businessName,
    businessCategory,
    businessAddress,
  } = body || {};

  if (typeof name !== 'string' || name.trim() === '') {
    return { error: 'Full name is required' };
  }

  const normalizedName = name.trim();

  if (normalizedName.length < 2 || normalizedName.length > 80) {
    return { error: 'Full name must be between 2 and 80 characters' };
  }

  if (typeof phone !== 'string' || phone.trim() === '') {
    return { error: 'Phone number is required' };
  }

  const normalizedPhone = normalizeSriLankanMobileNumber(phone);

  if (!normalizedPhone) {
    return { error: 'Enter a valid Sri Lankan mobile number' };
  }

  if (!ALLOWED_ROLES.has(role)) {
    return { error: 'Role must be either CUSTOMER or MERCHANT' };
  }

  const profile = {
    name: normalizedName,
    phone: normalizedPhone,
    role,
  };

  if (role === 'MERCHANT') {
    if (typeof businessName !== 'string' || businessName.trim() === '') {
      return { error: 'Business name is required' };
    }

    const normalizedBusinessName = businessName.trim();

    if (
      normalizedBusinessName.length < 2 ||
      normalizedBusinessName.length > 100
    ) {
      return { error: 'Business name must be between 2 and 100 characters' };
    }

    if (
      typeof businessCategory !== 'string' ||
      businessCategory.trim() === ''
    ) {
      return { error: 'Business category is required' };
    }

    if (!ALLOWED_BUSINESS_CATEGORIES.has(businessCategory)) {
      return { error: 'Invalid business category' };
    }

    if (
      typeof businessAddress !== 'string' ||
      businessAddress.trim() === ''
    ) {
      return { error: 'Business address is required' };
    }

    const normalizedBusinessAddress = businessAddress.trim();

    if (
      normalizedBusinessAddress.length < 5 ||
      normalizedBusinessAddress.length > 200
    ) {
      return {
        error: 'Business address must be between 5 and 200 characters',
      };
    }

    profile.businessName = normalizedBusinessName;
    profile.businessCategory = businessCategory;
    profile.businessAddress = normalizedBusinessAddress;
  }

  return { value: profile };
}

module.exports = {
  ALLOWED_BUSINESS_CATEGORIES,
  normalizeSriLankanMobileNumber,
  validateBootstrapInput,
};
