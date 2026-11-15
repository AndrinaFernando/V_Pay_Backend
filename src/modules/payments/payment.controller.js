const {
  PAYMENT_EXECUTION_OUTCOMES,
  PAYMENT_INTENT_OUTCOMES,
  confirmPaymentIntent,
  createPaymentIntent,
  getPaymentIntent,
  getPaymentStatus,
  previewPaymentIntent,
} = require('./payment.service');
const {
  validateConfirmPaymentIntentInput,
  validateCreatePaymentIntentInput,
} = require('./payment.validation');

function sendServiceError(res, outcome, accountType = 'merchant') {
  if (outcome === PAYMENT_INTENT_OUTCOMES.PROFILE_NOT_FOUND) {
    return res.status(404).json({
      success: false,
      ...(accountType === 'customer' && {
        code: 'CUSTOMER_PROFILE_NOT_FOUND',
      }),
      message: 'VPay user profile not found',
    });
  }

  if (outcome === PAYMENT_INTENT_OUTCOMES.ROLE_FORBIDDEN) {
    const message = accountType === 'customer'
      ? 'Only active customer accounts can preview payment intents'
      : 'Only active merchant accounts can access payment intents';

    return res.status(403).json({
      success: false,
      message,
    });
  }

  if (outcome === PAYMENT_INTENT_OUTCOMES.NOT_FOUND) {
    return res.status(404).json({
      success: false,
      ...(accountType === 'customer' && {
        code: 'PAYMENT_INTENT_NOT_FOUND',
      }),
      message: 'Payment intent not found',
    });
  }

  return res.status(500).json({
  success: false,
  message: 'Unable to process payment intent request',
});
}

function sendExecutionError(res, outcome) {
  const errors = {
    [PAYMENT_EXECUTION_OUTCOMES.PAYMENT_NOT_FOUND]: {
      status: 404,
      message: 'Payment intent not found',
    },
    [PAYMENT_EXECUTION_OUTCOMES.PAYMENT_EXPIRED]: {
      status: 410,
      message: 'Payment intent has expired',
    },
    [PAYMENT_EXECUTION_OUTCOMES.PAYMENT_FAILED]: {
      status: 409,
      message: 'Payment intent has failed',
    },
    [PAYMENT_EXECUTION_OUTCOMES.PAYMENT_ALREADY_PAID]: {
      status: 409,
      message: 'Payment intent has already been paid',
    },
    [PAYMENT_EXECUTION_OUTCOMES.PAYMENT_BELOW_MINIMUM]: {
      status: 409,
      message: 'Payment amount is below the minimum allowed amount',
    },
    [PAYMENT_EXECUTION_OUTCOMES.PAYMENT_LIMIT_EXCEEDED]: {
      status: 409,
      message: 'Payment amount exceeds the allowed transaction limit',
    },
    [PAYMENT_EXECUTION_OUTCOMES.INSUFFICIENT_BALANCE]: {
      status: 409,
      message: 'Insufficient customer balance',
    },
    [PAYMENT_EXECUTION_OUTCOMES.MINIMUM_BALANCE_REQUIRED]: {
      status: 409,
      message: 'Payment would reduce the card below the minimum retained balance',
    },
    [PAYMENT_EXECUTION_OUTCOMES.CARD_FROZEN]: {
      status: 409,
      message: 'Customer card is frozen',
    },
    [PAYMENT_EXECUTION_OUTCOMES.CARD_EXPIRED]: {
      status: 409,
      message: 'Customer card has expired',
    },
    [PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY]: {
      status: 403,
      message: 'Customer account is not ready for payments',
    },
    [PAYMENT_EXECUTION_OUTCOMES.MERCHANT_UNAVAILABLE]: {
      status: 409,
      message: 'Merchant is unavailable for payments',
    },
    [PAYMENT_EXECUTION_OUTCOMES.INVALID_BALANCE_SCHEMA]: {
      status: 409,
      message: 'Payment account requires balance migration',
    },
    [PAYMENT_EXECUTION_OUTCOMES.PAYMENT_CONFLICT]: {
      status: 409,
      message: 'Payment state is inconsistent',
    },
    [PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE]: {
      status: 503,
      message: 'QR payment execution is unavailable',
    },
  };
  const error = errors[outcome] || errors.PAYMENT_UNAVAILABLE;

  return res.status(error.status).json({
    success: false,
    code: errors[outcome]
      ? outcome
      : PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE,
    message: error.message,
  });
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

async function previewByReference(req, res) {
  if (req.user.emailVerified !== true) {
    return res.status(403).json({
      success: false,
      message: 'Email verification is required',
    });
  }

  try {
    const result = await previewPaymentIntent({
      uid: req.user.uid,
      paymentReference: req.params.paymentReference,
    });
    if (result.outcome !== PAYMENT_INTENT_OUTCOMES.FOUND) {
      return sendServiceError(res, result.outcome, 'customer');
    }

    return res.status(200).json({
      success: true,
      data: { paymentIntent: result.paymentIntent },
    });
  } catch (error) {
    console.error('Payment intent preview failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to preview payment intent',
    });
  }
}

async function confirmByReference(req, res) {
  if (req.user.emailVerified !== true) {
    return res.status(403).json({
      success: false,
      code: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY,
      message: 'Email verification is required',
    });
  }

  const validation = validateConfirmPaymentIntentInput(req.body);
  if (validation.error) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_REQUEST',
      message: validation.error,
    });
  }

  try {
    const result = await confirmPaymentIntent({
      uid: req.user.uid,
      paymentReference: req.params.paymentReference,
    });
    if (result.outcome !== PAYMENT_EXECUTION_OUTCOMES.SUCCEEDED) {
      return sendExecutionError(res, result.outcome);
    }

    return res.status(200).json({
      success: true,
      data: { payment: result.payment },
    });
  } catch (error) {
    console.error('Payment confirmation failed:', error.message);
    return sendExecutionError(
      res,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE,
    );
  }
}

async function getPaymentStatusByReference(req, res) {
  if (req.user.emailVerified !== true) {
    return res.status(403).json({
      success: false,
      code: PAYMENT_EXECUTION_OUTCOMES.ACCOUNT_NOT_READY,
      message: 'Email verification is required',
    });
  }

  try {
    const result = await getPaymentStatus({
      uid: req.user.uid,
      paymentReference: req.params.paymentReference,
    });
    if (result.outcome !== PAYMENT_INTENT_OUTCOMES.FOUND) {
      return sendExecutionError(res, result.outcome);
    }

    return res.status(200).json({
      success: true,
      data: { payment: result.payment },
    });
  } catch (error) {
    console.error('Payment status retrieval failed:', error.message);
    return sendExecutionError(
      res,
      PAYMENT_EXECUTION_OUTCOMES.PAYMENT_UNAVAILABLE,
    );
  }
}

module.exports = {
  confirmByReference,
  create,
  getByReference,
  getPaymentStatusByReference,
  previewByReference,
};
