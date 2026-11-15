
const express = require('express');

const authenticate = require('../../middleware/authenticate');

const {
  confirmByReference,
  create,
  getByReference,
  getPaymentStatusByReference,
  list,
  listCustomerTransactionHistory,
  previewByReference,
} = require('./payment.controller');

const router = express.Router();

// Merchant payment requests
router.post('/payment-intents', authenticate, create);
router.get('/payment-intents', authenticate, list);
router.get('/payment-intents/:paymentReference', authenticate, getByReference);

// Customer payment operations
router.get(
  '/customer/transactions',
  authenticate,
  listCustomerTransactionHistory,
);

router.get(
  '/payment-intents/:paymentReference/preview',
  authenticate,
  previewByReference,
);

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

module.exports = router;
