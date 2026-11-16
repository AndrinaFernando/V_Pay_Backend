# Merchant account backfill

The bootstrap endpoint now creates a missing `merchantAccounts/{uid}` document for an active merchant when no `transactions` record refers to that merchant and no successful payment intent exists. Existing accounts are never changed. Inactive or suspended profiles and merchants with payment history require review.

The backfill covers merchants who do not sign in again. It reads `users` profiles with role `MERCHANT`, checks their account and transaction history, and creates only eligible missing accounts with a zero LKR balance. It never updates an account, user profile, or financial record. Each apply decision is rechecked in a Firestore transaction and uses `create`, so a concurrent account cannot be overwritten.

## Procedure

1. Configure the existing Firebase Admin credentials as documented for this backend. Confirm the intended project ID independently.
2. Run `node scripts/backfill-merchant-accounts.js --dry-run --project-id=<project-id>` and save the summary and merchant IDs for review. Dry run is also the default when no mode is supplied.
3. Investigate every `review` result. Reconcile merchants with financial history against the authoritative ledger and decide their correct opening balance manually. Check inactive or suspended profiles with the account team. Do not use this utility to resolve those cases.
4. After separate database migration approval, run `node scripts/backfill-merchant-accounts.js --apply --project-id=<project-id>`. The supplied project ID must match the Firestore connection before the script writes.
5. Review the summary. An `error` result means that merchant was not initialized; investigate and rerun safely after resolving the cause. Repeated runs skip existing accounts.

Do not run apply against a production or shared Firebase project without migration approval. The utility detects records in the current `transactions` collection that contain `merchantUid` and successful records in `paymentIntents`. Legacy records elsewhere or records lacking `merchantUid` require separate reconciliation. The utility does not infer balances from payment records or activate a non-active merchant.
