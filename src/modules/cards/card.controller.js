const {
  CARD_LOOKUP_OUTCOMES,
  getCardForUser,
} = require('./card.service');

async function getCard(req, res) {
  try {
    const result = await getCardForUser(req.user.uid);

    if (result.outcome === CARD_LOOKUP_OUTCOMES.PROFILE_NOT_FOUND) {
      return res.status(404).json({
        success: false,
        message: 'VPay user profile not found',
      });
    }

    if (result.outcome === CARD_LOOKUP_OUTCOMES.ROLE_FORBIDDEN) {
      return res.status(403).json({
        success: false,
        message: result.role === 'MERCHANT'
          ? 'Merchant accounts do not have Customer virtual cards'
          : 'Customer virtual cards are unavailable for this account type',
      });
    }

    if (result.outcome === CARD_LOOKUP_OUTCOMES.CARD_NOT_FOUND) {
      return res.status(404).json({
        success: false,
        message: 'VPay virtual card not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: { card: result.card },
    });
  } catch (error) {
    console.error('Card retrieval failed:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve VPay virtual card',
    });
  }
}

module.exports = { getCard };
