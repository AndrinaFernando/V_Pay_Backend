const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createTopupService } = require('../../../src/modules/topups/topup.service');
const { createRupioAdapter } = require('../../../src/modules/topups/rupio.adapter');

function memoryDb(seed) {
  const records = new Map(Object.entries(seed));
  let nextId = 0;
  let tail = Promise.resolve();
  function reference(collection, id) {
    const path = `${collection}/${id}`;
    return { id, path, get: async () => snapshot(path) };
  }
  function snapshot(path) { return { exists: records.has(path), data: () => records.get(path) }; }
  return {
    records,
    collection(name) { return { doc: id => reference(name, id || `topup${++nextId}`) }; },
    runTransaction(fn) {
      const run = async () => {
        const changes = [];
        const tx = {
          get: async ref => snapshot(ref.path),
          create: (ref, data) => changes.push(() => { if (records.has(ref.path)) throw Error('already exists'); records.set(ref.path, data); }),
          update: (ref, data) => changes.push(() => records.set(ref.path, { ...records.get(ref.path), ...data })),
        };
        const result = await fn(tx);
        changes.forEach(change => change());
        return result;
      };
      const result = tail.then(run);
      tail = result.catch(() => {});
      return result;
    },
  };
}
function setup() {
  const db = memoryDb({ 'users/u1': { role: 'CUSTOMER', status: 'ACTIVE' }, 'cards/u1': { ownerId: 'u1', balance: 50.25 } });
  const gateway = {
    requireConfig() {},
    async startCheckout() { return { sessionId: 'rupio_sess_123', checkoutUrl: 'https://staging.example/checkout', expiresAt: '2030-01-01T00:00:00Z' }; },
  };
  return { db, gateway, service: createTopupService({ db, gateway }) };
}
const event = { eventId: 'rupio_pay_123', paymentId: 'rupio_pay_123', sessionId: 'rupio_sess_123', clientReference: 'topup1', requestedAmount: 100, amount: 120, currency: 'LKR', status: 'SUCCESS', message: 'approved' };

test('verified success credits actual checkout amount and records exactly once, including concurrent duplicate callbacks', async () => {
  const { db, service } = setup();
  await service.start({ uid: 'u1', amount: 100 });
  await Promise.all([service.applyEvent(event), service.applyEvent(event)]);
  assert.equal(db.records.get('cards/u1').balance, 170.25);
  assert.equal(db.records.get('topups/topup1').status, 'SUCCESS');
  assert.equal(db.records.get('transactions/topup_topup1').amount, 120);
  assert.equal([...db.records.keys()].filter(key => key.startsWith('transactions/')).length, 1);
});

test('failure, cancellation and timeout are recorded without credit', async () => {
  for (const status of ['FAILED', 'CANCELLED', 'TIMEOUT']) {
    const { db, service } = setup();
    await service.start({ uid: 'u1', amount: 100 });
    await service.applyEvent({ ...event, status });
    assert.equal(db.records.get('cards/u1').balance, 50.25);
    assert.equal(db.records.get('topups/topup1').status, status);
    assert.equal(db.records.has('transactions/topup_topup1'), false);
  }
});

test('mismatched session, amount, currency and late conflicting events do not change balance', async () => {
  const { db, service } = setup();
  await service.start({ uid: 'u1', amount: 100 });
  for (const bad of [{ sessionId: 'other' }, { requestedAmount: 101 }, { currency: 'USD' }, { amount: -1 }]) {
    await assert.rejects(service.applyEvent({ ...event, ...bad }));
  }
  assert.equal(db.records.get('cards/u1').balance, 50.25);
  await service.applyEvent({ ...event, status: 'FAILED' });
  await assert.rejects(service.applyEvent({ ...event, paymentId: 'different', eventId: 'different' }));
  assert.equal(db.records.get('cards/u1').balance, 50.25);
});

test('status reconciliation checks matching Rupio session and payment before crediting', async () => {
  const { db, service, gateway } = setup();
  await service.start({ uid: 'u1', amount: 100 });
  gateway.getSession = async () => ({ ...event });
  gateway.getPayment = async () => ({ ...event });
  assert.equal((await service.get({ uid: 'u1', id: 'topup1' })).status, 'SUCCESS');
  assert.equal(db.records.get('cards/u1').balance, 170.25);
  await assert.rejects(service.get({ uid: 'someone_else', id: 'topup1' }), /not found/);
});

test('callback signatures use the exact raw bytes and reject tampering', () => {
  const adapter = createRupioAdapter({ callbackSecret: 'testing-secret' });
  const raw = Buffer.from('{"amount":100}');
  const sig = `sha256=${crypto.createHmac('sha256', 'testing-secret').update(raw).digest('hex')}`;
  assert.equal(adapter.verifyCallback(raw, sig), true);
  assert.equal(adapter.verifyCallback(Buffer.from('{ "amount":100}'), sig), false);
  assert.equal(adapter.verifyCallback(raw, 'sha256=1234'), false);
});

test('only active customer accounts can start a top-up and amounts must be positive whole LKR', async () => {
  const { db, service } = setup();
  for (const amount of [0, -1, 1.5, 1000001, '100']) await assert.rejects(service.start({ uid: 'u1', amount }));
  db.records.set('users/u1', { role: 'MERCHANT', status: 'ACTIVE' });
  await assert.rejects(service.start({ uid: 'u1', amount: 100 }), /active customer/);
});

test('ambiguous session creation is retained as unknown, never a false payment failure', async () => {
  const { db, service, gateway } = setup();
  gateway.startCheckout = async () => { throw new Error('network timeout'); };
  await assert.rejects(service.start({ uid: 'u1', amount: 100 }), /could not be confirmed/);
  assert.equal(db.records.get('topups/topup1').status, 'START_UNKNOWN');
  assert.equal(db.records.get('cards/u1').balance, 50.25);
});

test('documented provider rejection is recorded as a failed checkout start without changing the balance', async () => {
  const { db, service, gateway } = setup();
  gateway.startCheckout = async () => { throw Object.assign(new Error('invalid API key'), { definiteRejection: true }); };
  await assert.rejects(service.start({ uid: 'u1', amount: 100 }), /rejected/);
  assert.equal(db.records.get('topups/topup1').status, 'START_FAILED');
  assert.equal(db.records.get('cards/u1').balance, 50.25);
});

test('unconfirmed or inconsistent provider reconciliation does not credit', async () => {
  const { db, service, gateway } = setup();
  await service.start({ uid: 'u1', amount: 100 });
  gateway.getSession = async () => ({ ...event });
  gateway.getPayment = async () => ({ ...event, amount: 200 });
  assert.equal((await service.get({ uid: 'u1', id: 'topup1' })).status, 'PENDING');
  assert.equal(db.records.get('cards/u1').balance, 50.25);
});

test('Rupio adapter sends the backend-only key and uses the returned checkout URL', async () => {
  let request;
  const adapter = createRupioAdapter({ baseUrl: 'https://gateway.example', apiKey: 'key', callbackSecret: 'secret', callbackUrl: 'https://vpay.example/api/webhooks/rupio',
    fetchImpl: async (url, options) => { request = { url, ...options }; return { ok: true, status: 201, json: async () => ({ sessionId: 'session1', checkoutUrl: 'https://checkout.example/exact', expiresAt: '2030-01-01T00:00:00Z' }) }; } });
  const result = await adapter.startCheckout({ reference: 'topup1', uid: 'u1', amount: 100 });
  assert.equal(request.url, 'https://gateway.example/api/v1/sessions');
  assert.equal(request.headers['X-API-Key'], 'key');
  assert.equal(JSON.parse(request.body).clientReference, 'topup1');
  assert.equal(result.checkoutUrl, 'https://checkout.example/exact');
});

test('website or unhealthy Rupio origin is rejected before the API key or top-up record is sent', async () => {
  const { db } = setup();
  let calls = 0;
  const gateway = createRupioAdapter({ baseUrl: 'https://website.example', apiKey: 'key', callbackSecret: 'secret', callbackUrl: 'https://vpay.example/api/webhooks/rupio',
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://website.example/health');
      assert.equal(options.headers['X-API-Key'], undefined);
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('HTML is not JSON'); } };
    } });
  const service = createTopupService({ db, gateway });
  await assert.rejects(service.start({ uid: 'u1', amount: 100 }), /not a reachable Rupio backend/);
  assert.equal(calls, 1);
  assert.equal(db.records.has('topups/topup1'), false);
  assert.equal(db.records.get('cards/u1').balance, 50.25);
});
