const express = require('express');

const authenticate = require('../../middleware/authenticate');
const { create, getByReference } = require('./payment.controller');

const router = express.Router();

router.post('/payment-intents', authenticate, create);
router.get('/payment-intents/:paymentReference', authenticate, getByReference);

module.exports = router;
