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
function setup(notifications) {
  const db = memoryDb({ 'users/u1': { role: 'CUSTOMER', status: 'ACTIVE' }, 'cards/u1': { ownerId: 'u1', balance: 50.25 } });
  const gateway = {
    requireConfig() {},
    async startCheckout() { return { sessionId: 'rupio_sess_123', checkoutUrl: 'https://staging.example/checkout', expiresAt: '2030-01-01T00:00:00Z' }; },
  };
  return { db, gateway, service: createTopupService({ db, gateway, notifications }) };
}
const event = { eventId: 'rupio_pay_123', paymentId: 'rupio_pay_123', sessionId: 'rupio_sess_123', clientReference: 'topup1', requestedAmount: 100, amount: 120, currency: 'LKR', status: 'SUCCESS', message: 'approved' };

test('top-up notifies only on first successful commit and ignores FCM failure', async () => {
  const sent = [];
  const { db, service } = setup({ notifyTopUpSuccess: async uid => {
    sent.push(uid);
    throw Error('FCM offline');
  } });
  await service.start({ uid: 'u1', amount: 100 });
  assert.equal((await service.applyEvent(event)).status, 'SUCCESS');
  await service.applyEvent(event);
  await service.applyEvent({ ...event, eventId: 'another_event' });
  assert.deepEqual(sent, ['u1']);
  assert.equal(db.records.get('cards/u1').balance, 170.25);
});

test('failed top-up never notifies', async () => {
  const sent = [];
  const { service } = setup({ notifyTopUpSuccess: async uid => sent.push(uid) });
  await service.start({ uid: 'u1', amount: 100 });
  await service.applyEvent({ ...event, status: 'FAILED' });
  assert.deepEqual(sent, []);
});

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

test('repeated non-success callbacks remain terminal without credit or a transaction', async () => {
  for (const status of ['FAILED', 'CANCELLED', 'TIMEOUT']) {
    const { db, service } = setup();
    await service.start({ uid: 'u1', amount: 100 });
    const result = { ...event, status };
    await service.applyEvent(result);
    await service.applyEvent(result);
    await service.applyEvent({ ...result, eventId: `repeat_${status}` });
    assert.equal(db.records.get('topups/topup1').status, status);
    assert.equal(db.records.get('cards/u1').balance, 50.25);
    assert.equal(db.records.has('transactions/topup_topup1'), false);
  }
});

test('success callbacks with different event IDs credit the same top-up only once', async () => {
  const { db, service } = setup();
  await service.start({ uid: 'u1', amount: 100 });
  await Promise.all([
    service.applyEvent(event),
    service.applyEvent({ ...event, eventId: 'second_event' }),
  ]);
  assert.equal(db.records.get('cards/u1').balance, 170.25);
  assert.equal(db.records.get('topups/topup1').status, 'SUCCESS');
  assert.equal(db.records.get('transactions/topup_topup1').amount, 120);
  assert.equal([...db.records.keys()].filter(key => key.startsWith('transactions/')).length, 1);
});

for (const [field, changedValue] of [['status', 'SUCCESS'], ['amount', 121]]) {
  test(`replayed event ID with changed ${field} is rejected without a credit`, async () => {
    const { db, service } = setup();
    await service.start({ uid: 'u1', amount: 100 });
    const original = { ...event, status: 'FAILED' };
    await service.applyEvent(original);
    const replay = await Promise.allSettled([service.applyEvent({ ...original, [field]: changedValue })]);
    assert.equal(db.records.get('cards/u1').balance, 50.25);
    assert.equal(db.records.get('topups/topup1').status, 'FAILED');
    assert.equal(db.records.has('transactions/topup_topup1'), false);
    assert.equal(replay[0].status, 'rejected', `changed ${field} must be treated as a conflicting event`);
    assert.equal(replay[0].reason.status, 409);
  });
}

test('concurrent callback and reconciliation credit one transaction', async () => {
  const { db, service, gateway } = setup();
  await service.start({ uid: 'u1', amount: 100 });
  let releaseSession;
  let signalSession;
  const enteredSession = new Promise(resolve => { signalSession = resolve; });
  const sessionGate = new Promise(resolve => { releaseSession = resolve; });
  gateway.getSession = async () => {
    signalSession();
    await sessionGate;
    return { ...event };
  };
  gateway.getPayment = async () => ({ ...event });
  const reconciliation = service.get({ uid: 'u1', id: 'topup1' });
  await enteredSession;
  const callback = service.applyEvent({ ...event, eventId: 'callback_event' });
  releaseSession();
  const [callbackResult, reconciled] = await Promise.all([callback, reconciliation]);
  assert.equal(callbackResult.status, 'SUCCESS');
  assert.equal(reconciled.status, 'SUCCESS');
  assert.equal(db.records.get('cards/u1').balance, 170.25);
  assert.equal(db.records.get('transactions/topup_topup1').amount, 120);
  assert.equal([...db.records.keys()].filter(key => key.startsWith('transactions/')).length, 1);
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

test('pending recovery keeps its status and balance when Rupio is unavailable', async () => {
  const { db, service, gateway } = setup();
  await service.start({ uid: 'u1', amount: 100 });
  gateway.getSession = async () => { throw new Error('temporary gateway outage'); };
  assert.equal((await service.get({ uid: 'u1', id: 'topup1' })).status, 'PENDING');
  assert.equal(db.records.get('topups/topup1').status, 'PENDING');
  assert.equal(db.records.get('cards/u1').balance, 50.25);
  assert.equal(db.records.has('transactions/topup_topup1'), false);
});

test('incomplete or nonterminal Rupio sessions do not invent a final result', async () => {
  for (const session of [null, { ...event, status: 'PENDING' }, { ...event, paymentId: null }]) {
    const { db, service, gateway } = setup();
    await service.start({ uid: 'u1', amount: 100 });
    let paymentLookups = 0;
    gateway.getSession = async () => session;
    gateway.getPayment = async () => { paymentLookups++; return { ...event }; };
    assert.equal((await service.get({ uid: 'u1', id: 'topup1' })).status, 'PENDING');
    assert.equal(db.records.get('topups/topup1').status, 'PENDING');
    assert.equal(db.records.get('cards/u1').balance, 50.25);
    assert.equal(db.records.has('transactions/topup_topup1'), false);
    assert.equal(paymentLookups, 0);
  }
});

test('delayed success finalizes once and a finalized top-up is not reconciled again', async () => {
  const { db, service, gateway } = setup();
  await service.start({ uid: 'u1', amount: 100 });
  gateway.getSession = async () => { throw new Error('temporary gateway outage'); };
  assert.equal((await service.get({ uid: 'u1', id: 'topup1' })).status, 'PENDING');
  await service.applyEvent(event);
  await service.applyEvent(event);
  let lookupsAfterFinalization = 0;
  gateway.getSession = async () => { lookupsAfterFinalization++; return { ...event }; };
  assert.equal((await service.get({ uid: 'u1', id: 'topup1' })).status, 'SUCCESS');
  assert.equal(lookupsAfterFinalization, 0);
  await assert.rejects(service.applyEvent({ ...event, eventId: 'conflicting', status: 'FAILED' }), { status: 409 });
  assert.equal(db.records.get('cards/u1').balance, 170.25);
  assert.equal(db.records.get('topups/topup1').status, 'SUCCESS');
  assert.equal(db.records.get('transactions/topup_topup1').amount, 120);
  assert.equal([...db.records.keys()].filter(key => key.startsWith('transactions/')).length, 1);
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
