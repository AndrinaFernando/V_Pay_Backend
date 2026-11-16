const express = require('express');
const authenticate = require('../../middleware/authenticate');
const { defaultService } = require('./notification.service');

function createNotificationRouter({ getService = defaultService } = {}) {
  const router = express.Router();
  router.post('/notifications/token', authenticate, async (req, res) => {
    try {
      const result = await getService().registerToken({
        uid: req.user.uid,
        fcmToken: req.body?.fcmToken,
      });
      if (result.status === 'INVALID_INPUT') {
        return res.status(400).json({ success: false, message: 'A valid FCM token is required' });
      }
      if (result.status === 'PROFILE_NOT_FOUND') {
        return res.status(404).json({ success: false, message: 'VPay user profile not found' });
      }
      if (result.status === 'REGISTERED') {
        return res.status(200).json({ success: true, message: 'FCM token registered', data: { bindingId: result.bindingId } });
      }
    } catch {
      // Do not log token-bearing request bodies or SDK errors.
    }
    return res.status(500).json({ success: false, message: 'Unable to register FCM token' });
  });
  router.delete('/notifications/token', authenticate, async (req, res) => {
    try {
      const result = await getService().unregisterToken({
        uid: req.user.uid,
        fcmToken: req.body?.fcmToken,
        bindingId: req.body?.bindingId,
      });
      if (result.status === 'INVALID_INPUT') {
        return res.status(400).json({ success: false, message: 'A valid FCM token and binding ID are required' });
      }
      if (result.status === 'UNREGISTERED') {
        return res.status(200).json({ success: true, message: 'FCM token unregistered' });
      }
    } catch {
      // Missing and foreign bindings have the same response; never log inputs.
    }
    return res.status(500).json({ success: false, message: 'Unable to unregister FCM token' });
  });
  return router;
}

module.exports = createNotificationRouter();
module.exports.createNotificationRouter = createNotificationRouter;
