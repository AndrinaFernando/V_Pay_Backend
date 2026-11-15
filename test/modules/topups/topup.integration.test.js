const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createTopupService } = require('../../../src/modules/topups/topup.service');
const { createRupioAdapter } = require('../../../src/modules/topups/rupio.adapter');

// An isolated Firestore stand-in: no test ever connects to the team's database.
function fakeFirestore() {
  const records = new Map([
    ['users/customer', { role: 'CUSTOMER', status: 'ACTIVE' }],
    ['cards/customer', { ownerId: 'customer', balance: 25 }],
  ]);
  let nextId = 0;
  let queue = Promise.resolve();
  const snapshot = path => ({ exists: records.has(path), data: () => records.get(path) });
  const doc = (collection, id) => {
    const path = `${collection}/${id}`;
    return { id, path, get: async () => snapshot(path) };
  };
  return {
    records,
    collection(name) {
      return {
        doc: id => doc(name, id || `topup${++nextId}`),
        where: (field, op, value) => ({ get: async () => ({
          docs: [...records].filter(([path, data]) => path.startsWith(`${name}/`) && data[field] === value)
            .map(([path, data]) => ({ id: path.slice(name.length + 1), data: () => data })),
        }) }),
      };
    },
    runTransaction(fn) {
      const action = async () => {
        const writes = [];
        const tx = {
          get: async ref => snapshot(ref.path),
          create: (ref, data) => writes.push(() => { if (records.has(ref.path)) throw Error('already exists'); records.set(ref.path, data); }),
          update: (ref, data) => writes.push(() => records.set(ref.path, { ...records.get(ref.path), ...data })),
        };
        const result = await fn(tx);
        writes.forEach(write => write());
        return result;
      };
      const result = queue.then(action);
      queue = result.catch(() => {});
      return result;
    },
  };
}

test('complete top-up HTTP flow: create session, signed callback, receipt, replay, and owner isolation', async () => {
  const db = fakeFirestore();
  let createRequest;
  const gateway = createRupioAdapter({
    baseUrl: 'https://rupio.example', apiKey: 'test-key', callbackSecret: 'test-secret',
    callbackUrl: 'https://vpay.example/api/webhooks/rupio',
    fetchImpl: async (url, options) => {
      if (url === 'https://rupio.example/health') {
        assert.equal(options.headers['X-API-Key'], undefined);
        return { ok: true, status: 200, json: async () => ({ status: 'ok', service: 'rupio' }) };
      }
      assert.equal(url, 'https://rupio.example/api/v1/sessions');
      createRequest = JSON.parse(options.body);
      assert.equal(options.headers['X-API-Key'], 'test-key');
      return { ok: true, status: 201, json: async () => ({
        sessionId: 'rupio_sess_test', checkoutUrl: 'https://checkout.example/abc', expiresAt: '2030-01-01T00:00:00Z',
      }) };
    },
  });
  const service = createTopupService({ db, gateway });
  const authPath = require.resolve('../../../src/middleware/authenticate');
  const servicePath = require.resolve('../../../src/modules/topups/topup.service');
  const adapterPath = require.resolve('../../../src/modules/topups/rupio.adapter');
  const old = [require.cache[authPath], require.cache[servicePath], require.cache[adapterPath]];
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: (req, res, next) => {
    if (!req.get('Authorization')) return res.sendStatus(401);
    req.user = { uid: req.get('Authorization') === 'Bearer owner' ? 'customer' : 'someone-else', emailVerified: true };
    next();
  } };
  require.cache[servicePath].exports.defaultService = () => service;
  require.cache[adapterPath].exports.defaultAdapter = () => gateway;
  const routerPath = require.resolve('../../../src/modules/topups/topup.routes');
  delete require.cache[routerPath];
  const app = express();
  app.use(express.json({ verify(req, res, body) { req.rawBody = Buffer.from(body); } }));
  app.use('/api', require(routerPath));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/topups`, {
      method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()).data.topup;
    assert.equal(created.status, 'PENDING');
    assert.equal(created.checkoutUrl, 'https://checkout.example/abc');
    assert.equal(createRequest.clientReference, created.id);
    assert.equal(createRequest.callbackUrl, 'https://vpay.example/api/webhooks/rupio');
    assert.equal(db.records.get('cards/customer').balance, 25);

    const event = { eventId: 'payment1', paymentId: 'payment1', sessionId: 'rupio_sess_test', clientReference: created.id,
      requestedAmount: 100, amount: 120, currency: 'LKR', status: 'SUCCESS', message: 'Test payment approved.' };
    const body = JSON.stringify(event);
    const signature = `sha256=${crypto.createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
    const callback = () => fetch(`${base}/api/webhooks/rupio`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Rupio-Signature': signature, 'X-Rupio-Event-Id': event.eventId,
    }, body });
    response = await callback();
    assert.equal(response.status, 200);
    response = await callback();
    assert.equal(response.status, 200);
    assert.equal(db.records.get('cards/customer').balance, 145);
    assert.equal(db.records.get(`transactions/topup_${created.id}`).type, 'TOP_UP');

    response = await fetch(`${base}/api/topups/${created.id}`, { headers: { Authorization: 'Bearer owner' } });
    assert.equal(response.status, 200);
    const receipt = (await response.json()).data.topup;
    assert.equal(receipt.status, 'SUCCESS');
    assert.equal(receipt.amount, 120);
    assert.equal(receipt.message, 'Test payment approved.');
    response = await fetch(`${base}/api/topups/${created.id}`, { headers: { Authorization: 'Bearer other' } });
    assert.equal(response.status, 404);
    response = await fetch(`${base}/api/topups`, { headers: { Authorization: 'Bearer owner' } });
    assert.equal((await response.json()).data.topups[0].status, 'SUCCESS');
  } finally {
    await new Promise(resolve => server.close(resolve));
    delete require.cache[routerPath];
    for (const [index, path] of [authPath, servicePath, adapterPath].entries()) {
      if (old[index]) require.cache[path] = old[index];
      else delete require.cache[path];
    }
  }
});
