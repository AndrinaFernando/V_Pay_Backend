const fs = require('fs');
const path = require('path');

const {
  initializeApp,
  getApps,
  cert,
} = require('firebase-admin/app');

const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

function getServiceAccount() {
  // Production: credential stored as an environment variable
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );

    if (serviceAccount.private_key) {
      serviceAccount.private_key =
        serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    return serviceAccount;
  }

  // Local development: credential stored in ignored JSON file
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const serviceAccountPath = path.resolve(
      process.cwd(),
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    );

    const serviceAccountFile = fs.readFileSync(
      serviceAccountPath,
      'utf8'
    );

    return JSON.parse(serviceAccountFile);
  }

  throw new Error(
    'Firebase Admin credentials are not configured'
  );
}

if (getApps().length === 0) {
  initializeApp({
    credential: cert(getServiceAccount()),
  });
}

const auth = getAuth();
const db = getFirestore();

module.exports = {
  auth,
  db,
};