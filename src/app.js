const express = require('express');
const cors = require('cors');

const userRoutes = require('./modules/users/user.routes');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'VPay backend is running',
  });
});

app.use('/api', userRoutes);

module.exports = app;
