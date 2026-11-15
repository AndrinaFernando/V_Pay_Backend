const express = require('express');

const authenticate = require('../../middleware/authenticate');
const { getCard } = require('./card.controller');

const router = express.Router();

router.get('/card', authenticate, getCard);

module.exports = router;
