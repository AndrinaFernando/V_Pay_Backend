const { auth } = require('../config/firebase');

async function authenticate(req, res, next) {
  try {
    const authorizationHeader = req.headers.authorization;

    if (
      !authorizationHeader ||
      !authorizationHeader.startsWith('Bearer ')
    ) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token is required',
      });
    }

    const idToken = authorizationHeader.split('Bearer ')[1].trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token is required',
      });
    }

    const decodedToken = await auth.verifyIdToken(idToken);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email ?? null,
      emailVerified: decodedToken.email_verified ?? false,
    };

    next();
  } catch (error) {
    console.error('Authentication failed:', error.code || error.message);

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired authentication token',
    });
  }
}

module.exports = authenticate;