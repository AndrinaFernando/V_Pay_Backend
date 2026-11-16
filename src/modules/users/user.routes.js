const express = require('express');

const authenticate = require('../../middleware/authenticate');
const { bootstrap, getMe, updateMe } = require('./user.controller');

const router = express.Router();

router.post('/users/bootstrap', authenticate, bootstrap);
router.get('/me', authenticate, getMe);
router.patch('/me', authenticate, updateMe);

module.exports = router;
