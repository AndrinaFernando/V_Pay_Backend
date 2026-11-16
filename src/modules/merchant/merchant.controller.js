const { db } = require('../../config/firebase');
const {
  MERCHANT_BALANCE_OUTCOMES,
  createMerchantService,
} = require('./merchant.service');

const merchantService = createMerchantService({ db });

async function getBalance(req, res) {
  if (req.user.emailVerified !== true) {
    return res.status(403).json({
      success: false,
      message: 'Email verification is required',
    });
  }

  try {
    const result = await merchantService.getBalance({ uid: req.user.uid });
    switch (result.outcome) {
      case MERCHANT_BALANCE_OUTCOMES.FOUND:
        return res.status(200).json({
          success: true,
          data: result.balance,
        });
      case MERCHANT_BALANCE_OUTCOMES.PROFILE_NOT_FOUND:
        return res.status(404).json({
          success: false,
          message: 'VPay user profile not found',
        });
      case MERCHANT_BALANCE_OUTCOMES.ROLE_FORBIDDEN:
        return res.status(403).json({
          success: false,
          message: 'Only active merchant accounts can view balance',
        });
      case MERCHANT_BALANCE_OUTCOMES.WALLET_NOT_FOUND:
        return res.status(404).json({
          success: false,
          message: 'Merchant wallet not found',
        });
      case MERCHANT_BALANCE_OUTCOMES.WALLET_UNAVAILABLE:
        return res.status(409).json({
          success: false,
          message: 'Merchant wallet is unavailable',
        });
      case MERCHANT_BALANCE_OUTCOMES.INVALID_WALLET:
        console.error('Merchant wallet has invalid balance data');
        return res.status(500).json({
          success: false,
          message: 'Merchant balance is unavailable',
        });
      default:
        return res.status(500).json({
          success: false,
          message: 'Unable to retrieve merchant balance',
        });
    }
  } catch (error) {
    console.error('Merchant balance retrieval failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to retrieve merchant balance',
    });
  }
}

module.exports = { getBalance };
