// ─── Environment Bindings ────────────────────────────────────────────
export interface Env {
  ORDERS: KVNamespace;
  CURSORS: KVNamespace;
  RATE_LIMITER: RateLimit;
  XLM_ADDRESS: string;
  XRP_ADDRESS: string;
  API_KEY: string;                  // API key required for order creation
  WEBHOOK_URL: string;
  WEBHOOK_SECRET: string;
  HORIZON_URL: string;
  XRPL_URL: string;
  ALLOWED_ORIGINS: string;          // comma-separated origins, or "*" for all
  CONFIRMATIONS_REQUIRED: string;   // number as string (env vars are always strings)
}

// ─── Order ───────────────────────────────────────────────────────────
export type Chain = "xlm" | "xrp";
export type OrderStatus =
  | "pending"
  | "partially_paid"
  | "confirming"
  | "paid"
  | "expired"
  | "cancelled";

export interface Payment {
  from: string;
  to: string;
  memo: string;           // memo (XLM) or destination tag (XRP)
  txHash: string;
  amount: string;         // decimal string
  confirmations: number;
  detectedAt: number;     // unix ms
}

export interface Order {
  id: string;
  chain: Chain;
  amount: string;         // expected amount, decimal string
  memo: string;           // the unique memo (XLM) or destination tag (XRP)
  status: OrderStatus;
  createdAt: number;      // unix ms
  expiresAt: number;      // unix ms
  payments: Payment[];    // all detected payments for this order
  txHash?: string;        // hash of the payment that completed the order
  paidAt?: number;
  paidAmount?: string;    // total paid across all payments
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

// ─── API Request / Response ──────────────────────────────────────────
export interface CreateOrderRequest {
  chain: Chain;
  amount: string;
  expiresInMinutes?: number; // default 60
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}

export interface CreateOrderResponse {
  orderId: string;
  chain: Chain;
  address: string;
  memo: string;
  amount: string;
  expiresAt: number;
}

export interface OrderStatusResponse {
  orderId: string;
  status: OrderStatus;
  chain: Chain;
  amount: string;
  memo: string;
  payments: Payment[];
  txHash?: string;
  paidAt?: number;
  paidAmount?: string;
}

// ─── Webhook Payload ─────────────────────────────────────────────────
export interface WebhookPayload {
  event: "payment.confirmed" | "payment.partial";
  orderId: string;
  chain: Chain;
  expectedAmount: string;
  paidAmount: string;
  memo: string;
  txHash: string;
  paidAt: number;
  payments: Payment[];
  metadata?: Record<string, string>;
}

// ─── Chain-specific types ────────────────────────────────────────────
export interface StellarPayment {
  id: string;
  transaction_hash: string;
  amount: string;
  asset_type: string;
  from: string;
  to: string;
  memo?: string;
  memo_type?: string;
  created_at: string;
  paging_token: string;
}

export interface XrplTransaction {
  hash: string;
  Account: string;
  Amount: string | { value: string; currency: string };
  Destination: string;
  DestinationTag?: number;
  date: number;
  meta?: {
    TransactionResult: string;
    delivered_amount?: string | { value: string };
  };
}
