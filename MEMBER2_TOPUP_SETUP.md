# Member 2: Rupio top-up setup

This is a simulated gateway integration. Use a dedicated staging Rupio service and team-approved VPay test accounts. Coordinate schema and staging data with the team before testing against a shared Firestore database.

## Local backend

Install dependencies with `npm ci`. Copy `.env.example` to `.env`, set `FIREBASE_SERVICE_ACCOUNT_PATH` to the existing approved Firebase Admin key, and supply these values through a secure channel:

- `RUPIO_BASE_URL`: Rupio backend HTTPS origin only (no `/api/v1`).
- `RUPIO_API_KEY`: Rupio staging service key.
- `RUPIO_CALLBACK_SECRET`: signing secret shared with Rupio, distinct from the API key.
- `RUPIO_CALLBACK_URL`: publicly reachable HTTPS URL ending in `/api/webhooks/rupio` on this VPay backend. A phone's localhost or a computer's private address is not reachable from Rupio. Use an approved HTTPS tunnel or staging deployment.

`RUPIO_BASE_URL` is the staging **backend API** origin, not the Vercel checkout website. The backend checks that its `/health` response identifies Rupio before sending the API key or creating a top-up.

The actual `.env` and Firebase key must stay private and are ignored by Git. Do not put these keys in Flutter or commit them. Start with `npm start`, then check `/api/health`.

For a temporary local tunnel, run `node scripts/rupio-callback-proxy.js` and point the HTTPS tunnel at `http://127.0.0.1:3002`. The proxy forwards only `POST /api/webhooks/rupio` to the local backend on port 3001; all other routes return 404. Put the resulting public HTTPS URL plus `/api/webhooks/rupio` in `RUPIO_CALLBACK_URL` and restart the backend. This proxy is only for local testing. A temporary tunnel URL can change when restarted.

## Flow and contracts

`POST /api/topups` requires a verified Firebase user and a JSON integer `amount` (whole LKR, 1 through 1,000,000). It stores a `CREATING` top-up before asking Rupio for a session; on a confirmed response it records the session and returns a `PENDING` top-up and checkout URL. A documented validation or API-key rejection becomes `START_FAILED`. An ambiguous session-creation error becomes `START_UNKNOWN`; contact support before retrying because Rupio may have received the request.

`GET /api/topups` returns up to 100 records for the signed-in user. `GET /api/topups/:id` returns only the owner's record and attempts a server-to-server Rupio status reconciliation for pending sessions. The callback route `POST /api/webhooks/rupio` verifies the HMAC over the exact raw body and checks the event ID, session, reference, currency, and amount. A successful result atomically writes the event and `TOP_UP` transaction and credits the customer's card once. Other terminal statuses leave the balance unchanged. Rupio permits editing the amount during checkout; the validated final amount, not the initial requested amount, is credited. The browser return is never proof of payment.

If callback delivery fails, a signed-in user opening or refreshing the top-up can trigger reconciliation. If VPay never received a session ID, an ambiguous start must be investigated with the Rupio operator. Do not manually credit the card.

## Tests

Run `node --test`. For an end-to-end staging test, verify success, decline, cancellation, timeout, repeated callbacks, and an edited amount with the Rupio test cards in the Rupio guide. Check both the VPay `topups` and `transactions` records, and confirm only one credit is made. Never use real payment card data.
