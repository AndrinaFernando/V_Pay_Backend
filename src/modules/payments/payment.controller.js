const {
  PAYMENT_INTENT_OUTCOMES,
  createPaymentIntent,
  getPaymentIntent,
  listPaymentIntents,
} = require('./payment.service');
const {
  validateCreatePaymentIntentInput,
  validateListPaymentIntentsQuery,
} = require('./payment.validation');

function sendServiceError(res, outcome) {
  if (outcome === PAYMENT_INTENT_OUTCOMES.PROFILE_NOT_FOUND) {
    return res.status(404).json({
      success: false,
      message: 'VPay user profile not found',
    });
  }

  if (outcome === PAYMENT_INTENT_OUTCOMES.ROLE_FORBIDDEN) {
    return res.status(403).json({
      success: false,
      message: 'Only active merchant accounts can access payment intents',
    });
  }

  if (outcome === PAYMENT_INTENT_OUTCOMES.NOT_FOUND) {
    return res.status(404).json({
      success: false,
      message: 'Payment intent not found',
    });
  }

  return null;
}

async function create(req, res) {
  if (req.user.emailVerified !== true) {
    return res.status(403).json({
      success: false,
      message: 'Email verification is required',
    });
  }

  const validation = validateCreatePaymentIntentInput(req.body);
  if (validation.error) {
    return res.status(400).json({
      success: false,
      message: validation.error,
    });
  }

  try {
    const result = await createPaymentIntent({
      uid: req.user.uid,
      ...validation.value,
    });
    if (result.outcome !== PAYMENT_INTENT_OUTCOMES.CREATED) {
      return sendServiceError(res, result.outcome);
    }

    return res.status(201).json({
      success: true,
      data: { paymentIntent: result.paymentIntent },
    });
  } catch (error) {
    console.error('Payment intent creation failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to create payment intent',
    });
  }
}

async function getByReference(req, res) {
  if (req.user.emailVerified !== true) {
    return res.status(403).json({
      success: false,
      message: 'Email verification is required',
    });
  }

  try {
    const result = await getPaymentIntent({
      uid: req.user.uid,
      paymentReference: req.params.paymentReference,
    });
    if (result.outcome !== PAYMENT_INTENT_OUTCOMES.FOUND) {
      return sendServiceError(res, result.outcome);
    }

    return res.status(200).json({
      success: true,
      data: { paymentIntent: result.paymentIntent },
    });
  } catch (error) {
    console.error('Payment intent retrieval failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve payment intent',
    });
  }
}

async function list(req, res) {
  if (req.user.emailVerified !== true) {
    return res.status(403).json({
      success: false,
      message: 'Email verification is required',
    });
  }

  const validation = validateListPaymentIntentsQuery(req.query);
  if (validation.error) {
    return res.status(400).json({ success: false, message: validation.error });
  }

  try {
    const result = await listPaymentIntents({
      uid: req.user.uid,
      ...validation.value,
    });
    if (result.outcome !== PAYMENT_INTENT_OUTCOMES.LISTED) {
      return sendServiceError(res, result.outcome);
    }

    return res.status(200).json({
      success: true,
      data: { paymentIntents: result.paymentIntents },
    });
  } catch (error) {
    console.error('Payment intent listing failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve payment intents',
    });
  }
}

module.exports = { create, getByReference, list };
