const INITIAL_ACCOUNT = Object.freeze({
  balanceMinor: 0,
  currency: 'LKR',
  status: 'ACTIVE',
});

async function inspectMerchant(db, uid, read) {
  const userRef = db.collection('users').doc(uid);
  const accountRef = db.collection('merchantAccounts').doc(uid);
  const user = await read(userRef);
  const account = await read(accountRef);
  if (account.exists) return { outcome: 'existing' };
  if (!user.exists || user.data().role !== 'MERCHANT') {
    return { outcome: 'review', reason: 'profile missing or role changed' };
  }
  if (user.data().status !== 'ACTIVE') {
    return { outcome: 'review', reason: 'profile is not active' };
  }
  const history = await read(
    db.collection('transactions').where('merchantUid', '==', uid).limit(1),
  );
  if (!history.empty) {
    return { outcome: 'review', reason: 'merchant has financial history' };
  }
  const intents = await read(
    db.collection('paymentIntents').where('merchantUid', '==', uid),
  );
  if (intents.docs.some((intent) => intent.data().status === 'SUCCESS')) {
    return { outcome: 'review', reason: 'merchant has a successful payment intent' };
  }
  return { outcome: 'eligible', accountRef };
}

async function backfillMerchantAccounts(db, { apply = false, onResult = () => {} } = {}) {
  const merchants = await db.collection('users').where('role', '==', 'MERCHANT').get();
  const summary = { scanned: 0, eligible: 0, created: 0, existing: 0, review: 0, errors: 0 };
  for (const merchant of merchants.docs) {
    summary.scanned += 1;
    try {
      const result = apply
        ? await db.runTransaction(async (transaction) => {
          const current = await inspectMerchant(db, merchant.id, (ref) => transaction.get(ref));
          if (current.outcome === 'eligible') {
            transaction.create(current.accountRef, INITIAL_ACCOUNT);
            return { outcome: 'created' };
          }
          return current;
        })
        : await inspectMerchant(db, merchant.id, (ref) => ref.get());
      summary[result.outcome] += 1;
      onResult({ uid: merchant.id, outcome: result.outcome, reason: result.reason });
    } catch (error) {
      summary.errors += 1;
      onResult({ uid: merchant.id, outcome: 'error', reason: error.message });
    }
  }
  return summary;
}

function parseArgs(args) {
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const projectArg = args.find((arg) => arg.startsWith('--project-id='));
  if (apply && dryRun) throw new Error('Choose either --apply or --dry-run');
  if (args.some((arg) => !['--apply', '--dry-run'].includes(arg) && arg !== projectArg)) {
    throw new Error('Unknown argument');
  }
  const projectId = projectArg?.slice('--project-id='.length);
  if (apply && !projectId) throw new Error('--apply requires --project-id=<Firebase project ID>');
  return { apply, projectId };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const { db } = require('../src/config/firebase');
  // A read initializes Firestore's resolved project ID before any write is possible.
  await db.collection('users').limit(1).get();
  const actualProjectId = db.projectId;
  if (options.projectId && options.projectId !== actualProjectId) {
    throw new Error(`Project mismatch: connected to ${actualProjectId}`);
  }
  console.log(`Project: ${actualProjectId}; mode: ${options.apply ? 'APPLY' : 'DRY RUN'}`);
  const summary = await backfillMerchantAccounts(db, {
    apply: options.apply,
    onResult: ({ uid, outcome, reason }) =>
      console.log(`${uid}: ${outcome}${reason ? ` (${reason})` : ''}`),
  });
  console.log('Summary:', summary);
  if (summary.errors) process.exitCode = 1;
  return summary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Backfill stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { backfillMerchantAccounts, inspectMerchant, parseArgs };
