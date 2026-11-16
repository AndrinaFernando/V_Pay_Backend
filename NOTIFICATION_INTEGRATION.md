# Notification integration

## Architecture and scope

The CommonJS notification module uses the existing Express routing and Firebase Admin default app. `notification.service.js` owns profile access and messaging; `notification.routes.js` maps authenticated HTTP requests to the service. `src/app.js` mounts the router under `/api`.

`createNotificationService({ db, messaging })` injects Firestore-compatible and Messaging-compatible dependencies. Tests use in-memory fakes, never real Firebase or actual pushes. `defaultService()` lazily uses the existing `src/config/firebase.js` database and Admin `getMessaging()`. Importing the service alone does not load credentials. No additional dependencies, collections, financial writes, or financial integration hooks were added.

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

Both service objects expose the four send functions above plus `registerToken({ uid, fcmToken })`. Registration is intended for the authenticated route, not an arbitrary client-selected UID. There is no standalone exported `registerToken` function. `defaultService()` itself can throw on configuration failure; production callers should use the standalone notification functions, which contain initialization failures.

Supported types are exactly `TOP_UP_SUCCESS`, `PAYMENT_SUCCESS`, and `PAYMENT_RECEIVED`. The helper functions select these types respectively. UIDs must be nonempty, at most 128 characters, without surrounding whitespace or `/`. Callers must obtain recipients from trusted server-side operation data. The service does not authorize a financial operation or infer customer/merchant ownership.

Notification results contain only `{ status }`:

- `SENT`: FCM accepted the request; this does not prove device delivery.
- `INVALID_INPUT`: invalid UID or unsupported type.
- `PROFILE_NOT_FOUND`: recipient profile does not exist.
- `MISSING_TOKEN`: token is absent, null, or empty.
- `INVALID_TOKEN`: stored token fails local validation.
- `PROFILE_READ_FAILED`: user lookup failed.
- `MESSAGING_FAILED`: Firebase Messaging rejected or failed the send.
- `SERVICE_UNAVAILABLE`: standalone helper could not initialize/use the service.

The send functions read `users/{uid}.fcmToken` and perform no database writes. Payloads contain a generic title/body and `data: { type }`. They contain no amounts, balances, card details, transaction identifiers, or personal details. No raw tokens or SDK errors are logged or returned. There is no automatic retry or invalid-token deletion.

## Token registration

`POST /api/notifications/token`

Headers: `Authorization: Bearer <Firebase ID token>` and `Content-Type: application/json`.

```json
{ "fcmToken": "<device FCM registration token>" }
```

The existing `authenticate` middleware verifies the ID token and supplies `req.user.uid`. Any body `uid` or other extra fields are ignored. The route updates only `fcmToken` using Firestore `update()`, which preserves unrelated fields and fails when the profile does not exist. It does not create a user. A valid Firebase identity is required; this route adds no separate email-verification requirement.

Local validation accepts 1–4096 printable ASCII characters without whitespace. This is a defensive input limit, not an official FCM token format or proof of token ownership/deliverability. Only Firebase can determine whether a submitted token is usable.

| HTTP status | Response |
| --- | --- |
| 200 | `{ "success": true, "message": "FCM token registered" }` |
| 400 | `{ "success": false, "message": "A valid FCM token is required" }` |
| 401 | Existing middleware response for missing/invalid/expired authentication |
| 404 | `{ "success": false, "message": "VPay user profile not found" }` |
| 500 | `{ "success": false, "message": "Unable to register FCM token" }` |

`registerToken` resolves to `{ status }`, with `REGISTERED`, `INVALID_INPUT`, `PROFILE_NOT_FOUND`, or `TOKEN_UPDATE_FAILED`. The raw token is never echoed. The confirmed single-field schema supports **one device per user**: the last successful registration replaces the previous device token.

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

- Configure Firebase Messaging and platform notification permissions/configuration.
- Obtain a device token and register it after authentication and profile creation, using a current Firebase ID token.
- Re-register on token refresh and authenticated account/device changes; handle 401 and profile-not-ready 404 responses.
- Implement foreground presentation, background handling, and notification-open behavior using `data.type`; fetch authoritative state from the backend.
- Account for the single-device replacement behavior and lack of guaranteed push delivery.
- Coordinate a safe token removal/account-switch design before shipping shared-device logout support. No removal endpoint or logout change is implemented; those flows need inspection and approval first. Generic notification text reduces exposed detail but does not resolve stale-device registration.

## Validation

Run `npm test` from the backend repository. The notification suite uses fake Firestore/Messaging plus the real authentication middleware with a fake ID-token verifier and local HTTP requests. No real Firebase credentials or push sends are required.

Validated result: 54 total tests, 53 passed, 0 failed, 1 skipped. All 15 added notification tests passed. The skipped Firestore top-up test is an existing opt-in emulator test and was not modified or disabled.
