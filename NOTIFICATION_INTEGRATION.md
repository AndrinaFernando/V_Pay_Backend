# Notification integration

## Architecture and scope

The CommonJS notification module uses the existing Express routing and Firebase Admin default app. `notification.service.js` owns profile access and messaging; `notification.routes.js` maps authenticated HTTP requests to the service. `src/app.js` mounts the router under `/api`.

`createNotificationService({ db, messaging })` injects Firestore-compatible and Messaging-compatible dependencies. Unit tests use in-memory fakes; optional concurrency tests use only a guarded local Firestore Emulator. No tests send actual pushes. `defaultService()` lazily uses the existing `src/config/firebase.js` database and Admin `getMessaging()`. Importing the service alone does not load credentials. The only additional collection is `fcmTokenOwners`; there are no new dependencies, financial writes, or financial integration hooks.

## Exported service API

Import from `src/modules/notifications/notification.service.js` (use the appropriate relative path).

| Export | Parameters | Return |
| --- | --- | --- |
| `notifyTopUpSuccess` | `uid`: customer UID string | Promise of notification result |
| `notifyPaymentSuccess` | `uid`: customer UID string | Promise of notification result |
| `notifyPaymentReceived` | `uid`: merchant UID string | Promise of notification result |
| `sendNotification` | `{ uid, type }` | Promise of notification result |
| `createNotificationService` | `{ db, messaging }` | Injectable service object |
| `defaultService` | None | Lazily initialized production service object |

Both service objects expose the four send functions above plus `registerToken({ uid, fcmToken })` and `unregisterToken({ uid, fcmToken, bindingId })`. Token management is intended for authenticated routes, not an arbitrary client-selected UID. There are no standalone token-management exports. `defaultService()` itself can throw on configuration failure; production send callers should use the standalone notification functions, which contain initialization failures. Existing sender signatures are unchanged.

Supported types are exactly `TOP_UP_SUCCESS`, `PAYMENT_SUCCESS`, and `PAYMENT_RECEIVED`. The helper functions select these types respectively. UIDs must be nonempty, at most 128 characters, without surrounding whitespace or `/`. Callers must obtain recipients from trusted server-side operation data. The service does not authorize a financial operation or infer customer/merchant ownership.

Notification results contain only `{ status }`:

- `SENT`: FCM accepted the request; this does not prove device delivery.
- `INVALID_INPUT`: invalid UID or unsupported type.
- `PROFILE_NOT_FOUND`: recipient profile does not exist.
- `MISSING_TOKEN`: token is absent, null, or empty.
- `INVALID_TOKEN`: stored token fails local validation.
- `UNVERIFIED_TOKEN`: authoritative ownership is absent, belongs to another UID, or has an invalid binding ID.
- `PROFILE_READ_FAILED`: profile/ownership transaction failed.
- `MESSAGING_FAILED`: Firebase Messaging rejected or failed the send.
- `SERVICE_UNAVAILABLE`: standalone helper could not initialize/use the service.

The sender reads `users/{uid}.fcmToken` and the corresponding ownership record in one transaction, then calls FCM outside the transaction. An unverified profile token is never a fallback. The data-only message is exactly `{ token, data: { type, bindingId } }`: there is no `notification` field, automatically displayed text, UID, amount, balance, card detail, or transaction identifier. Flutter must validate the active binding before displaying anything.

On `messaging/registration-token-not-registered` or `messaging/invalid-registration-token`, the service conditionally removes only the UID/token/binding captured for that send. A delayed failure cannot delete a newer binding. Other errors, including generic `messaging/invalid-argument`, preserve registration because they can indicate payload, configuration, or transient problems. Cleanup failure still returns a sanitized `MESSAGING_FAILED`; neither SDK errors nor raw tokens are logged or returned. There is no automatic send retry or age-based token expiry.

## Ownership schema and transactions

```text
users/{uid}
  fcmToken: string | null

fcmTokenOwners/{sha256(fcmToken)}
  uid: string
  bindingId: server-generated UUID v4
  updatedAt: Firestore server timestamp
```

The registry is authoritative. The profile retains the single-device lookup pointer for compatibility. The SHA-256 key uses the exact token bytes; tokens are not trimmed or normalized. Hashing avoids raw tokens in document paths, but is not an authorization mechanism. No composite index, device subcollection, session service, or queue is needed.

Registration reads the requesting profile, incoming token owner, previous token owner (if replacing), and former owner's profile (if transferring) before writing anything. The transaction clears the former profile only if its token still matches, deletes the requester's previous ownership only if it still belongs to that UID, updates only the requester's `fcmToken`, and writes a fresh binding with a server timestamp. A missing requester profile causes no writes. A malformed incoming owner UID fails closed. Missing former profiles do not prevent a valid transfer.

All claims for a token touch its deterministic ownership document, and competing tokens for one user also touch the same user document. Firestore transactions serialize the changes and retry contention. If retries are exhausted, the API returns a sanitized 500, not a false success. No FCM call occurs in a transaction callback. The last committed registration wins; another concurrent registration can supersede a successful response.

The invariants assume controlled legacy migration and exclusively trusted backend writers. A registry cannot discover all historical duplicate profile fields without migration. Legacy profile-only tokens are never eligible to send, even before cleanup. A fully transactional reverse query over users is an alternative, but requires indexed token lookup and potentially many duplicate profile updates; the registry provides bounded document coordination.

Firestore rules must deny client reads/writes of `fcmTokenOwners` and client writes to profile notification fields, including on profile creation. Verify the deployed rules: this repository does not contain them, and this task does not deploy any. Ordinary `GET /api/me` and bootstrap responses omit `fcmToken` without altering stored profiles or card data.

## Token registration

`POST /api/notifications/token`

Headers: `Authorization: Bearer <Firebase ID token>` and `Content-Type: application/json`.

```json
{ "fcmToken": "<device FCM registration token>" }
```

The existing `authenticate` middleware verifies the ID token and supplies `req.user.uid`. Any body `uid`, `bindingId`, or other extra fields are ignored. Registration transfers ownership using the transaction described above. It does not create a user or change unrelated profile fields. A valid Firebase identity is required; this route adds no separate email-verification requirement.

Local validation accepts 1–4096 printable ASCII characters without whitespace. This is a defensive input limit, not an official FCM token format or proof of token ownership/deliverability. Only Firebase can determine whether a submitted token is usable.

| HTTP status | Response |
| --- | --- |
| 200 | `{ "success": true, "message": "FCM token registered", "data": { "bindingId": "<UUID v4>" } }` |
| 400 | `{ "success": false, "message": "A valid FCM token is required" }` |
| 401 | Existing middleware response for missing/invalid/expired authentication |
| 404 | `{ "success": false, "message": "VPay user profile not found" }` |
| 500 | `{ "success": false, "message": "Unable to register FCM token" }` |

`registerToken` resolves to `{ status: 'REGISTERED', bindingId }` on success, or `{ status }` with `INVALID_INPUT`, `PROFILE_NOT_FOUND`, or `TOKEN_UPDATE_FAILED`. Every successful POST creates a new binding, including a retry of the same UID and token. Flutter must serialize registration and retain the latest confirmed response; a timeout means the commit outcome may be unknown, so re-register under the same still-active login session to obtain a confirmed binding. The raw token is never echoed. The schema still supports **one device per user**.

## Token unregistration

`DELETE /api/notifications/token`

Use the same bearer authentication and JSON content type as POST. The token and binding belong in the request body, not the URL or query string:

```json
{ "fcmToken": "<device FCM registration token>", "bindingId": "<binding returned by POST>" }
```

The service validates the UID, token, and canonical lowercase UUID v4 binding. In a transaction it removes ownership only when the registry UID equals `req.user.uid` and the exact binding matches. It clears the user profile token only if it still equals the supplied token. A missing profile does not prevent removal of a matching ownership record. No other profile fields change.

| HTTP status | Response |
| --- | --- |
| 200 | `{ "success": true, "message": "FCM token unregistered" }` |
| 400 | `{ "success": false, "message": "A valid FCM token and binding ID are required" }` |
| 401 | Existing middleware response for missing/invalid/expired authentication |
| 500 | `{ "success": false, "message": "Unable to unregister FCM token" }` |

Already removed, nonexistent, foreign-UID, and outdated bindings all return the same successful no-op response. They do not expose current ownership or clear a newer profile token. An old logout cannot remove a newer binding even if the same UID registers the same token again. Body-supplied UIDs are ignored. Service results are `UNREGISTERED`, `INVALID_INPUT`, or `TOKEN_UPDATE_FAILED`.

## Member 2: top-up integration

The following notification call belongs after a successful financial commit, outside the Firestore transaction callback. `customerUid` must come from the committed top-up's trusted owner record:

```js
const { notifyTopUpSuccess } = require('../notifications/notification.service');

// In the operation owner's post-commit success path:
const notificationAttempt = await notifyTopUpSuccess(customerUid);
// Optional safe telemetry: notificationAttempt.status only.
// Preserve and return the already-committed top-up result regardless of status.
```

The existing top-up service has `applyEvent(event)` and reconciliation through `get(...)`. `applyEvent` can return an existing successful result on replay; a successful result alone does not prove a new commit. Member 2 must distinguish the first successful transition and coordinate callback/reconciliation paths before installing this hook. No such business-logic change is included here.

## Member 4: payment integration

After the payment owner has committed a successful payment and established the trusted customer and merchant UIDs:

```js
const {
  notifyPaymentSuccess,
  notifyPaymentReceived,
} = require('../notifications/notification.service');

// In the operation owner's post-commit success path:
const notificationAttempts = await Promise.all([
  notifyPaymentSuccess(customerUid),
  notifyPaymentReceived(merchantUid),
]);
// Optional safe telemetry: each attempt.status only.
// Preserve the committed payment result even if either notification fails.
```

These snippets show actual notification APIs, not a proposed payment execution contract. Existing payment intent creation is not payment completion and must not trigger success notifications. Member 4's execution API is not assumed here.

## Failure handling and duplicate attempts

Notifications are informational. Never send from a financial transaction callback: Firestore may rerun that callback. Await the committed financial operation first. Never throw a payment failure, roll back, refund, or rerun a financial operation because a notification status is not `SENT`. The standalone helpers resolve failure statuses for database, messaging, and initialization errors.

This module has no deduplication storage and provides no exactly-once guarantee. Operation owners should use a stable committed operation identifier plus recipient/type to coordinate notification attempts, and suppress attempts on payment retries and repeated callbacks. A durable attempt claim requires an agreed owner-managed design; no new fields or collections are silently introduced here. An in-memory flag cannot coordinate multiple processes. A process crash between claiming and sending can lose a notification; sending before recording success can duplicate it after a crash. FCM acceptance timeouts can also leave delivery uncertain. Owners must agree on that tradeoff before enabling retries; do not retry financial work to retry a push.

## Remaining Flutter integration

- Update the older POST response parser to read `data.bindingId`. Store the confirmed UID, token, binding ID, and active/inactive notification state in storage accessible to background handlers. Do not log tokens or include them in telemetry.
- Register only after authentication and profile creation, using the current Firebase ID token. Register on token refresh and account changes; handle 401, profile-not-ready 404, and 500 without reporting a financial failure.
- Add authenticated DELETE with the exact token and binding ID. Never replay account A's deletion with account B's credentials. Do not treat missing/foreign no-op responses as evidence of ownership.
- Serialize registration, token-refresh handling, and logout. Associate every callback/response with the login session that started it; stop old-session retries and discard stale responses. A delayed authenticated POST can otherwise reclaim a token: Firestore commit order does not reveal which account is currently on screen. Client sign-out is not immediate revocation of an already issued Firebase ID token.
- On online logout, first mark local notifications inactive and stop new registration work. Settle outstanding registration requests, call DELETE while the old account's credentials are still available, attempt token invalidation through the installed Flutter Messaging SDK, clear displayed notifications/local active binding, and sign out. Do not block logout indefinitely on network failure.
- On account switching, activate notifications only after the new account has a confirmed binding. Reuse of the same token transfers ownership atomically. Token rotation after an unsuccessful logout does not itself remove the old token's backend record.
- Adapt to data-only messages. Check the current authenticated account and its active confirmed binding against `data.bindingId` before foreground/background presentation and again before handling an open action. Suppress messages when state is absent, inactive, or unverifiable. Define the generic display text locally from `data.type`; fetch financial state through authenticated APIs.
- Coordinate notification presentation with logout so an in-flight local handler cannot present after the active binding is cleared. Background isolates must read persisted current state rather than a captured foreground variable. Clear old delivered notifications during logout.
- Offline logout must immediately deactivate local notifications and suppress old-binding messages. It cannot immediately remove backend ownership, guarantee remote token invalidation, or recall queued FCM messages. Do not retain old account credentials solely for cleanup. Retry token invalidation when connectivity returns; backend removal requires appropriately authenticated cleanup, a transfer of that same token, or a definitive invalid-token send result. No time-based expiry is implemented, so unreachable stale records can remain until one of those events.
- Data-only background delivery is platform dependent and may be delayed or suppressed. Prefer missed notifications over displaying a message for the wrong binding; configure and test Android/iOS behavior explicitly.

**Full push privacy is not established by this backend change alone.** The mobile repository is unchanged and the updated client behavior must be implemented and tested. Database transactions cannot revoke an FCM request already sent or prevent a transfer immediately after the sender's ownership snapshot. Carrying the captured binding lets the updated client reject that obsolete message. Existing notification payloads already queued by an older sender may still be automatically displayed.

Token possession is not cryptographic proof of device ownership. Authenticated clients can submit tokens they know; keep tokens confidential. This change does not add device attestation, possession challenges, or a server-side login-session ordering protocol.

## Controlled migration and rollout

No production records are changed by this implementation, and there is no automatic backfill. Do not generate ownership records from historical profile tokens: those profiles do not identify the account currently using the device.

1. Coordinate the updated Flutter release and backend cutover. Gate notification sending and token registration during migration. Stop/drain old backend instances and in-flight legacy registration requests; do not allow mixed old writers to resume.
2. In a separately approved operator procedure, clear legacy `users/{uid}.fcmToken` fields while writers are paused. Preserve every unrelated profile/financial field. If any ownership records already exist from an earlier rollout, review them as part of the controlled reset rather than leaving stale bindings behind. No migration script or production operation is included here.
3. Verify client Firestore permissions prohibit bypassing the backend registry and that ordinary profile responses no longer expose tokens. Ensure proxies accept JSON DELETE bodies and request logging redacts authorization headers and token-bearing bodies.
4. Enable only the new transactional endpoints and ownership-verifying sender. Require fresh authenticated registrations. Legacy profile-only tokens remain skipped; do not restore a fallback sender to recover delivery.
5. Test real account switching, concurrent requests, offline logout, delayed/queued messages, background presentation, and notification-open behavior with the updated Flutter app before declaring privacy complete.

Expect a notification interruption until clients register again. Existing helper imports remain valid, but old clients expecting an auto-displayed `notification` payload are not presentation-compatible. Rolling back to the old sender or writer after migration would reintroduce the vulnerability. Keep sending gated if rollback is necessary.

## Branch integration notes

Implementation started on clean `feature/notification-token-security` at `7f475e9`, matching locally recorded `feature/notifications` and `origin/feature/notifications`. Locally recorded `origin/development` is `f2c60b7` (20 development-only commits and one notification-only commit); the local `development` branch is older. GitHub was unreachable during review, so remote freshness was not confirmed.

The existing notification branch and development both changed `src/app.js`; a future integration must retain both merchant and notification routers. Development also has newer user/merchant provisioning in `user.service.js`; this change leaves that service alone and filters tokens at the controller response boundary. No merge, rebase, payment hook, or financial implementation change is included. Owners must coordinate post-commit notification hooks and deduplication separately.

## Validation

Run `npm test` from the backend repository. The notification unit suite uses fake Firestore/Messaging plus the real authentication middleware with a fake ID-token verifier and local HTTP requests. Profile privacy tests exercise both ordinary profile response paths with fake service data. No real Firebase credentials or push sends are required.

Validated result: **78 tests, 74 passed, 0 failed, 4 skipped**. The initial sandboxed targeted run could not spawn Node test processes (`EPERM`); the full `npm test` run succeeded outside that sandbox. Three new notification concurrency tests and the existing top-up emulator test were skipped because no Firestore Emulator was configured. No real Firestore concurrency result is claimed from the serialized fake.

The optional notification emulator tests cover competing accounts for one token, competing tokens for one account, and stale logout racing renewal/transfer. They refuse any host except `127.0.0.1:8188`, use only project `demo-vpay-notifications`, create unique test documents, and clean up only those documents. Start a local Firestore Emulator on that address, then run:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8188'
node --test test/modules/notifications/notification.emulator.test.js
```

The existing full-suite top-up emulator test uses the same host with a separate demo project. Run the emulator tests before deployment; this repository's initial CI on development does not provision an emulator. No 30-day expiry policy is implemented.
