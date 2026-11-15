const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const crypto = require('node:crypto');

test('webhook validates signature and event header before processing; top-up routes require authentication', async () => {
  const authPath = require.resolve('../../../src/middleware/authenticate');
  const servicePath = require.resolve('../../../src/modules/topups/topup.service');
  const adapterPath = require.resolve('../../../src/modules/topups/rupio.adapter');
  const { createRupioAdapter } = require(adapterPath);
  let calls = 0;
  const service = { applyEvent: async () => { calls++; } };
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: (req, res) => res.sendStatus(401) };
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: { defaultService: () => service } };
  require.cache[adapterPath].exports.defaultAdapter = () => createRupioAdapter({ callbackSecret: 'secret' });
  const routes = require('../../../src/modules/topups/topup.routes');
  const app = express();
  app.use(express.json({ verify(req, res, buffer) { req.rawBody = Buffer.from(buffer); } }));
  app.use('/api', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ eventId: 'event1' });
  const signature = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
  try {
    let response = await fetch(`${base}/api/webhooks/rupio`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rupio-Event-Id': 'event1', 'X-Rupio-Signature': 'sha256=bad' }, body });
    assert.equal(response.status, 401);
    response = await fetch(`${base}/api/webhooks/rupio`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rupio-Event-Id': 'other', 'X-Rupio-Signature': signature }, body });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
    response = await fetch(`${base}/api/webhooks/rupio`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rupio-Event-Id': 'event1', 'X-Rupio-Signature': signature }, body });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    response = await fetch(`${base}/api/topups`);
    assert.equal(response.status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
