const express = require('express');

const authenticate = require('../../middleware/authenticate');
const {
  confirmByReference,
  create,
  getByReference,
  getPaymentStatusByReference,
  previewByReference,
} = require('./payment.controller');

const router = express.Router();

router.post('/payment-intents', authenticate, create);
router.post(
  '/payment-intents/:paymentReference/confirm',
  authenticate,
  confirmByReference,
);
router.get(
  '/payment-intents/:paymentReference/payment-status',
  authenticate,
  getPaymentStatusByReference,
);
router.get(
  '/payment-intents/:paymentReference/preview',
  authenticate,
  previewByReference,
);
router.get('/payment-intents/:paymentReference', authenticate, getByReference);

module.exports = router;
