const express = require('express');
const cors = require('cors');

const userRoutes = require('./modules/users/user.routes');
const cardRoutes = require('./modules/cards/card.routes');
const paymentRoutes = require('./modules/payments/payment.routes');
const topupRoutes = require('./modules/topups/topup.routes');
const notificationRoutes = require('./modules/notifications/notification.routes');

const app = express();

app.use(cors());
app.use(express.json({ verify(req, res, buffer) { req.rawBody = Buffer.from(buffer); } }));

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'VPay backend is running',
  });
});

app.use('/api', userRoutes);
app.use('/api', cardRoutes);
app.use('/api', paymentRoutes);
app.use('/api', topupRoutes);
app.use('/api', notificationRoutes);

module.exports = app;
