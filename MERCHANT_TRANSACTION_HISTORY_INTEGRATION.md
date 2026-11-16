# Merchant transaction history — Member 3 handoff

## Request

`GET /api/merchant/transactions?limit=20`

Send `Authorization: Bearer <Firebase ID token>`. The existing authentication middleware verifies the token. The account must have verified email and an existing `users/{uid}` profile with `role: MERCHANT` and `status: ACTIVE`.

`limit` is optional, defaults to 20, and accepts integer strings from 1 through 50. Invalid, empty, or repeated limits return 400. Other query fields do not select ownership: supplied `uid` or `merchantUid` values are ignored. Ownership always comes from the verified token.

## Success response

HTTP 200:

```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "transactionId": "qr-payment--example-reference",
        "paymentReference": "example-reference",
        "amountMinor": 12345,
        "currency": "LKR",
        "status": "SUCCESS",
        "createdAt": "2026-11-16T10:00:00.000Z"
      }
    ]
  }
}
```

Each item contains exactly these six fields. No customer UID, merchant UID, card information, balance, or internal intent fields are returned. `amountMinor` is a positive safe integer in minor units: 12345 means LKR 123.45. Do not treat it as whole rupees. `createdAt` uses the customer-history ISO 8601 UTC serialization, including milliseconds and `Z`; Flutter can parse it with `DateTime.parse` and display local time.

Results contain only the authenticated merchant's `QR_PAYMENT` records with `SUCCESS` status, ordered by `createdAt` descending. Empty history returns HTTP 200 with `{ "success": true, "data": { "transactions": [] } }`. The limit selects the most recent matching rows; cursor pagination and totals are not provided.

## Errors

Errors use `{ "success": false, "message": "..." }`.

| HTTP | Message / condition |
| --- | --- |
| 400 | `limit must be an integer from 1 to 50` |
| 401 | `Authentication token is required` or `Invalid or expired authentication token` |
| 403 | `Email verification is required` |
| 403 | `Only active merchant accounts can access merchant transactions` |
| 404 | `VPay user profile not found` |
| 500 | `Unable to retrieve merchant transactions` for database failures or inconsistent records |

Email verification is checked before query validation; profile authorization follows validation. Display failures as errors, not an empty successful history. Refresh authentication when needed; do not retry or execute payments to load this endpoint.

## Integrity and implementation

The payment service exports `listMerchantTransactions({ uid, limit = 20 })`; `createPaymentService({ db, ... })` exposes the same injectable method. The controller supplies validated limits and authenticated UID. The result is `{ outcome: 'LISTED', transactions }`, or the existing profile/role authorization outcomes. Storage and integrity errors reject and are converted into a safe HTTP 500.

The implementation reuses the existing merchant profile checks, query-limit validator, QR consistency helper, and timestamp serializer. Each returned record is checked against its referenced authoritative payment intent, including merchant/customer linkage, successful intent state, matching amount/currency, and matching transaction creation/payment time. Amounts must be positive safe integers in LKR. Following customer history's integrity policy, a missing or inconsistent intent fails the whole request; it is never silently omitted or repaired. No records, intents, or balances are written.

## Firestore index and rollout

`firestore.indexes.json` adds this collection-scope composite index for `transactions`, preserving existing indexes:

1. `merchantUid` ASCENDING
2. `type` ASCENDING
3. `status` ASCENDING
4. `createdAt` DESCENDING

An authorized maintainer must deploy the index to the intended Firebase project and wait until it is ready before enabling dashboard traffic. No index or backend deployment was performed as part of this change. A missing index produces the safe 500 response.

Member 3 can connect the dashboard to the endpoint, format minor units, render local dates, and handle loading, empty, authentication, authorization, and error states. Flutter changes are separate. The backend change is based on approved customer-payment commit `d6425e4`; integrate through the team's normal review process without replacing that baseline.

## Validation

Run `npm test` in the backend directory. New merchant tests use fake Firestore and a fake Firebase identity verifier with the real middleware, router, controller, and service. They never access Firebase or financial data. The full run reported 147 tests: 146 passed, 0 failed, 1 skipped; two existing emulator suites were also skipped by their environment gates. Existing tests were not disabled or modified.
