const express = require('express');

const authenticate = require('../../middleware/authenticate');
const { getBalance } = require('./merchant.controller');

const router = express.Router();

router.get('/merchant/balance', authenticate, getBalance);

module.exports = router;
