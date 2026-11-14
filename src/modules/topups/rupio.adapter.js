const crypto = require('node:crypto');

function createRupioAdapter({ baseUrl, apiKey, callbackSecret, callbackUrl, fetchImpl = fetch }) {
  function requireConfig() {
    if (!baseUrl || !apiKey || !callbackSecret || !callbackUrl) {
      throw Object.assign(new Error('Rupio staging is not configured on the backend.'), { status: 503 });
    }
    const origin = new URL(baseUrl);
    const callback = new URL(callbackUrl);
    if (origin.protocol !== 'https:' || callback.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || callback.username || callback.password) {
      throw Object.assign(new Error('Rupio origin and public callback must use HTTPS.'), { status: 503 });
    }
  }

  async function verifyEndpoint() {
    requireConfig();
    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      const body = await response.json();
      if (!response.ok || body.status !== 'ok' || body.service !== 'rupio') throw new Error('unexpected health response');
    } catch (_) {
      throw Object.assign(new Error('The Rupio URL is not a reachable Rupio backend. Check the staging API address.'), { status: 503 });
    }
  }

  async function request(path, options = {}) {
    requireConfig();
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...options,
      headers: { 'X-API-Key': apiKey, Accept: 'application/json', ...options.headers },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if (!response.ok) {
      const error = new Error(`Rupio request failed (${response.status})`);
      // Rupio documents 400/401 as validation/authentication rejection before session creation.
      error.definiteRejection = options.method === 'POST' && [400, 401].includes(response.status);
      throw error;
    }
    if (options.method === 'POST' && response.status !== 201) throw new Error('Rupio did not confirm checkout creation');
    return response.json();
  }

  async function startCheckout({ reference, uid, amount }) {
    const result = await request('/api/v1/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientReference: reference, customerReference: uid, amount, currency: 'LKR', callbackUrl }),
    });
    const checkout = new URL(result.checkoutUrl);
    if (checkout.protocol !== 'https:' || checkout.username || checkout.password || !result.sessionId || Number.isNaN(Date.parse(result.expiresAt))) {
      throw new Error('Rupio returned an invalid checkout session');
    }
    return result;
  }

  async function getSession(sessionId) {
    return (await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)).session;
  }

  async function getPayment(paymentId) {
    return (await request(`/api/v1/payments/${encodeURIComponent(paymentId)}`)).payment;
  }

  function verifyCallback(rawBody, signature) {
    if (!callbackSecret || !Buffer.isBuffer(rawBody) || !/^sha256=[a-f0-9]{64}$/i.test(signature || '')) return false;
    const expected = crypto.createHmac('sha256', callbackSecret).update(rawBody).digest();
    const actual = Buffer.from(signature.slice(7), 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  return { requireConfig, verifyEndpoint, startCheckout, getSession, getPayment, verifyCallback };
}

function defaultAdapter() {
  return createRupioAdapter({ baseUrl: process.env.RUPIO_BASE_URL, apiKey: process.env.RUPIO_API_KEY, callbackSecret: process.env.RUPIO_CALLBACK_SECRET, callbackUrl: process.env.RUPIO_CALLBACK_URL });
}

module.exports = { createRupioAdapter, defaultAdapter };
