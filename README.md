# Crypto Checkout Worker

A Cloudflare Worker that accepts **XLM** (Stellar) and **XRP** (Ripple) payments. It uses a single wallet address per chain with unique memo/destination-tag tracking, polls the blockchain for incoming transactions, and notifies your backend via signed webhooks.

Built with **Hono**, **TypeScript**, **Cloudflare KV**, and **Workers Rate Limiting**.

## How It Works

```
1. Your backend creates an order via POST /api/orders
2. Worker returns a wallet address + unique memo (XLM) or destination tag (XRP)
3. Customer sends payment to that address with the memo/tag
4. Cron job (every 1 min) polls Stellar Horizon & XRPL for matching transactions
5. Order status updates: pending → partially_paid → confirming → paid
6. Worker fires a signed webhook to your backend on payment events
```

### Order State Machine

```
pending ──→ partially_paid ──→ confirming ──→ paid
  │              │
  └── expired ───┘
  │              │
  └─ cancelled ──┘
```

- **pending** — waiting for payment
- **partially_paid** — received less than the expected amount
- **confirming** — full amount received, waiting for confirmation cycles (if `CONFIRMATIONS_REQUIRED > 1`)
- **paid** — payment confirmed
- **expired** — no payment received before `expiresAt`
- **cancelled** — manually cancelled via API

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create KV namespaces

```bash
npx wrangler kv namespace create ORDERS
npx wrangler kv namespace create CURSORS
```

Copy the returned IDs into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  { "binding": "ORDERS", "id": "<your-orders-kv-id>" },
  { "binding": "CURSORS", "id": "<your-cursors-kv-id>" }
]
```

### 3. Set secrets

These are sensitive values and must be set as encrypted secrets, **not** in `wrangler.jsonc` vars:

```bash
npx wrangler secret put XLM_ADDRESS      # Your Stellar receiving wallet address
npx wrangler secret put XRP_ADDRESS      # Your XRP receiving wallet address
npx wrangler secret put API_KEY          # API key for authenticating requests
npx wrangler secret put WEBHOOK_URL      # Your backend endpoint for payment notifications
npx wrangler secret put WEBHOOK_SECRET   # HMAC-SHA256 secret for signing webhooks
```

| Secret | Required | Description |
|--------|----------|-------------|
| `XLM_ADDRESS` | Yes | Stellar wallet address that receives XLM payments |
| `XRP_ADDRESS` | Yes | XRP wallet address that receives XRP payments |
| `API_KEY` | Yes | Bearer token required on all `/api/*` requests |
| `WEBHOOK_URL` | No | URL where payment event webhooks are POSTed. Skipped if empty |
| `WEBHOOK_SECRET` | No | Secret used to HMAC-SHA256 sign webhook payloads |

### 4. Configure environment variables (optional)

These are non-sensitive and can be set in `wrangler.jsonc` under `vars`:

| Variable | Default | Description |
|----------|---------|-------------|
| `HORIZON_URL` | `https://horizon.stellar.org` | Stellar Horizon API endpoint |
| `XRPL_URL` | `https://s1.ripple.com:51234` | XRPL JSON-RPC endpoint |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins, or `*` for all |
| `CONFIRMATIONS_REQUIRED` | `1` | Poll cycles before marking payment as confirmed |

### 5. Run

```bash
npm run dev       # Local development
npm run deploy    # Deploy to Cloudflare
npm run tail      # Stream live logs
```

## API Reference

All endpoints require the `Authorization: Bearer <API_KEY>` header.

Rate limiting is enforced per IP (60 requests/minute) via Cloudflare Workers Rate Limiting.

### POST /api/orders

Create a new payment order.

**Request body:**

```json
{
  "chain": "xlm",
  "amount": "10.5",
  "expiresInMinutes": 60,
  "metadata": { "userId": "abc123" },
  "idempotencyKey": "unique-key-123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chain` | `"xlm"` or `"xrp"` | Yes | Which blockchain to accept payment on |
| `amount` | string | Yes | Expected payment amount as a decimal string |
| `expiresInMinutes` | number | No | Minutes until order expires (1–1440, default 60) |
| `metadata` | object | No | Arbitrary key-value pairs passed through to webhooks |
| `idempotencyKey` | string | No | Prevents duplicate order creation |

**Response (201):**

```json
{
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "chain": "xlm",
  "address": "GABCD...",
  "memo": "837492651",
  "amount": "10.5",
  "expiresAt": 1719500000000,
  "paymentInstructions": {
    "address": "GABCD...",
    "memo": "837492651",
    "amount": "10.5",
    "currency": "XLM",
    "note": "Send exactly 10.5 XLM to GABCD... with MEMO: 837492651"
  }
}
```

For XRP orders, `paymentInstructions` contains `destinationTag` instead of `memo`.

### GET /api/orders/:orderId

Poll the current status of an order.

**Response (200):**

```json
{
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "paid",
  "chain": "xlm",
  "amount": "10.5",
  "memo": "837492651",
  "payments": [
    {
      "from": "GSEND...",
      "to": "GABCD...",
      "memo": "837492651",
      "txHash": "abc123...",
      "amount": "10.5",
      "confirmations": 1,
      "detectedAt": 1719499000000
    }
  ],
  "txHash": "abc123...",
  "paidAt": 1719499000000,
  "paidAmount": "10.5"
}
```

### POST /api/orders/:orderId/cancel

Cancel a pending or partially paid order.

**Response (200):**

```json
{
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "cancelled"
}
```

Returns `400` if the order is already in a terminal status (`paid`, `expired`, `cancelled`).

## Webhooks

When a payment is detected, the worker POSTs a signed JSON payload to your `WEBHOOK_URL`.

### Events

| Event | Fired when |
|-------|-----------|
| `payment.confirmed` | Full amount received and confirmed |
| `payment.partial` | Payment received but less than the expected amount |

### Payload

```json
{
  "event": "payment.confirmed",
  "orderId": "550e8400-e29b-41d4-a716-446655440000",
  "chain": "xlm",
  "expectedAmount": "10.5",
  "paidAmount": "10.5",
  "memo": "837492651",
  "txHash": "abc123...",
  "paidAt": 1719499000000,
  "payments": [],
  "metadata": { "userId": "abc123" }
}
```

### Signature Verification

Each webhook includes an `X-Signature` header containing an HMAC-SHA256 hex digest of the raw JSON body, signed with `WEBHOOK_SECRET`.

Verify in Node.js:

```js
const crypto = require("crypto");

function verifyWebhook(body, signature, secret) {
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

Headers sent with each webhook:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-Signature` | HMAC-SHA256 hex digest |
| `X-Webhook-Event` | Event name (e.g. `payment.confirmed`) |

Webhooks retry up to 3 times with exponential backoff (1s, 2s, 4s) on failure.

## Project Structure

```
src/
  index.ts              Entry point, cron handler, middleware
  types.ts              TypeScript interfaces for the entire app
  routes/
    orders.ts           REST API route handlers
  chains/
    stellar.ts          Stellar Horizon blockchain poller
    xrpl.ts             XRPL JSON-RPC blockchain poller
  services/
    store.ts            KV storage layer (orders, memos, lists)
    webhook.ts          HMAC-signed webhook delivery with retries
  utils/
    decimal.ts          Precise decimal arithmetic (BigInt-based)
```

## Testnet Development

Uncomment the `env.dev` block in `wrangler.jsonc` to use testnet endpoints:

```jsonc
"env": {
  "dev": {
    "vars": {
      "HORIZON_URL": "https://horizon-testnet.stellar.org",
      "XRPL_URL": "https://s.altnet.rippletest.net:51234",
      "ALLOWED_ORIGINS": "*"
    }
  }
}
```

Then run with `npx wrangler dev --env dev`.
