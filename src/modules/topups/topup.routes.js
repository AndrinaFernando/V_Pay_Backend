const express = require('express');
const authenticate = require('../../middleware/authenticate');
const { defaultService } = require('./topup.service');
const { defaultAdapter } = require('./rupio.adapter');
const router = express.Router();

function report(res, error) {
  if (!error.status || error.status >= 500) console.error('Top-up request failed:', error.message);
  return res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'Unable to process the top-up.' });
}
function verified(req, res, next) {
  if (req.user.emailVerified !== true) return res.status(403).json({ success: false, message: 'Email verification is required.' });
  next();
}

router.post('/webhooks/rupio', async (req, res) => {
  const signature = req.get('X-Rupio-Signature');
  if (!defaultAdapter().verifyCallback(req.rawBody, signature)) return res.status(401).json({ success: false, message: 'Invalid signature.' });
  if (req.get('X-Rupio-Event-Id') !== req.body?.eventId) return res.status(400).json({ success: false, message: 'Event identifier mismatch.' });
  try {
    await defaultService().applyEvent(req.body);
    return res.sendStatus(200);
  } catch (error) { return report(res, error); }
});

router.post('/topups', authenticate, verified, async (req, res) => {
  try {
    const topup = await defaultService().start({ uid: req.user.uid, amount: req.body?.amount });
    return res.status(201).json({ success: true, data: { topup } });
  } catch (error) { return report(res, error); }
});
router.get('/topups', authenticate, verified, async (req, res) => {
  try { return res.json({ success: true, data: { topups: await defaultService().list({ uid: req.user.uid }) } }); }
  catch (error) { return report(res, error); }
});
router.get('/topups/:id', authenticate, verified, async (req, res) => {
  try { return res.json({ success: true, data: { topup: await defaultService().get({ uid: req.user.uid, id: req.params.id }) } }); }
  catch (error) { return report(res, error); }
});

module.exports = router;
