const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const firebaseConfigPath = require.resolve('../../src/config/firebase');
let verifyIdToken = async () => ({
  uid: 'merchant-uid-from-verified-token',
  email: 'merchant@example.test',
  email_verified: true,
});

const firebaseConfigStub = new Module(firebaseConfigPath);
firebaseConfigStub.filename = firebaseConfigPath;
firebaseConfigStub.loaded = true;
firebaseConfigStub.exports = {
  auth: {
    verifyIdToken: (...args) => verifyIdToken(...args),
  },
};
require.cache[firebaseConfigPath] = firebaseConfigStub;

const authenticate = require('../../src/middleware/authenticate');

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('verifies the bearer token and derives request identity from its claims', async () => {
  const req = { headers: { authorization: 'Bearer valid-id-token' } };
  const res = makeResponse();
  let nextCalled = false;
  let verifiedToken;

  verifyIdToken = async (token) => {
    verifiedToken = token;
    return {
      uid: 'verified-uid',
      email: 'merchant@example.test',
      email_verified: true,
      role: 'CUSTOMER',
    };
  };

  await authenticate(req, res, () => {
    nextCalled = true;
  });

  assert.equal(verifiedToken, 'valid-id-token');
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, {
    uid: 'verified-uid',
    email: 'merchant@example.test',
    emailVerified: true,
  });
  assert.equal('role' in req.user, false);
});

test('rejects a missing bearer token', async () => {
  const req = { headers: {} };
  const res = makeResponse();
  let nextCalled = false;

  await authenticate(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.equal(nextCalled, false);
});

test('rejects a token Firebase cannot verify', async () => {
  verifyIdToken = async () => {
    throw new Error('invalid token');
  };
  const req = { headers: { authorization: 'Bearer invalid-id-token' } };
  const res = makeResponse();
  let nextCalled = false;

  await authenticate(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.equal(nextCalled, false);
});
