const DEFAULT_MAX_PAYMENT_AMOUNT_MINOR = 2_000_000;

async function getMaximumPaymentAmountMinor({
  customerUid,
  customerProfile,
} = {}) {
  // These trusted service-layer inputs are reserved for a future
  // customer-specific policy. HTTP request data is never authoritative here.
  void customerUid;
  void customerProfile;
  return DEFAULT_MAX_PAYMENT_AMOUNT_MINOR;
}

module.exports = {
  DEFAULT_MAX_PAYMENT_AMOUNT_MINOR,
  getMaximumPaymentAmountMinor,
};
