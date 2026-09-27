const {
  BOOTSTRAP_OUTCOMES,
  bootstrapUser,
  getUserByUid,
} = require('./user.service');

const ALLOWED_ROLES = new Set(['CUSTOMER', 'MERCHANT']);

async function bootstrap(req, res) {
  try {
    const { uid, email, emailVerified } = req.user;

    if (emailVerified !== true) {
      return res.status(403).json({
        success: false,
        message: 'Email verification is required',
      });
    }

    const { name, role } = req.body || {};

    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Name must be a non-empty string',
      });
    }

    if (!ALLOWED_ROLES.has(role)) {
      return res.status(400).json({
        success: false,
        message: 'Role must be either CUSTOMER or MERCHANT',
      });
    }

    const result = await bootstrapUser({
      uid,
      email,
      name: name.trim(),
      role,
    });

    if (result.outcome === BOOTSTRAP_OUTCOMES.ROLE_CONFLICT) {
      return res.status(409).json({
        success: false,
        message: 'Existing account has a different role',
      });
    }

    const statusCode =
      result.outcome === BOOTSTRAP_OUTCOMES.CREATED ? 201 : 200;

    return res.status(statusCode).json({
      success: true,
      message: 'User bootstrap completed',
      data: {
        user: result.user,
        card: result.card,
      },
    });
  } catch (error) {
    console.error('User bootstrap failed:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to complete user bootstrap',
    });
  }
}

async function getMe(req, res) {
  try {
    const { uid, emailVerified } = req.user;

    if (emailVerified !== true) {
      return res.status(403).json({
        success: false,
        message: 'Email verification is required',
      });
    }

    const user = await getUserByUid(uid);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'VPay user profile not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        user,
      },
    });
  } catch (error) {
    console.error('User profile retrieval failed:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve user profile',
    });
  }
}

module.exports = {
  bootstrap,
  getMe,
};
