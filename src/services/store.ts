import type { Env, Order, Chain, OrderStatus } from "../types";

const ORDER_TTL = 60 * 60 * 24; // 24h TTL for KV entries

// ─── Key helpers ─────────────────────────────────────────────────────
const orderKey = (id: string) => `order:${id}`;
const memoKey = (chain: Chain, memo: string) => `memo:${chain}:${memo}`;
const pendingListKey = (chain: Chain) => `pending:${chain}`;
const confirmingListKey = (chain: Chain) => `confirming:${chain}`;
const idempotencyKey = (key: string) => `idempotency:${key}`;


// ─── Memo / Tag generation ───────────────────────────────────────────
// XRP destination tags are uint32 (0 – 4,294,967,295).
// XLM memos (MEMO_TEXT) can be up to 28 bytes — we use numeric strings.
// Uses crypto.getRandomValues for cryptographic randomness.

export async function generateUniqueMemo(
  env: Env,
  chain: Chain
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);

    const value =
      chain === "xrp"
        ? array[0].toString()                       // uint32 range: 0–4294967295
        : (array[0] % 999_999_999).toString();      // 9-digit numeric string

    const existing = await env.ORDERS.get(memoKey(chain, value));
    if (!existing) return value;
  }

  // Fallback: UUID-based to guarantee uniqueness
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return chain === "xrp"
    ? (parseInt(uuid.slice(0, 8), 16) >>> 0).toString()   // uint32 from UUID hex
    : parseInt(uuid.slice(0, 7), 16).toString().slice(0, 9);
}

// ─── CRUD ────────────────────────────────────────────────────────────
export async function saveOrder(env: Env, order: Order): Promise<void> {
  const data = JSON.stringify(order);

  await Promise.all([
    env.ORDERS.put(orderKey(order.id), data, { expirationTtl: ORDER_TTL }),
    env.ORDERS.put(memoKey(order.chain, order.memo), order.id, { expirationTtl: ORDER_TTL }),
  ]);

  await addToPendingList(env, order.chain, order.id);
}

export async function getOrder(env: Env, id: string): Promise<Order | null> {
  const raw = await env.ORDERS.get(orderKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Order;
  } catch {
    console.error(`Failed to parse order ${id}`);
    return null;
  }
}

export async function updateOrder(env: Env, order: Order): Promise<void> {
  await env.ORDERS.put(orderKey(order.id), JSON.stringify(order), {
    expirationTtl: ORDER_TTL,
  });
}

/**
 * Race-safe update: re-reads order from KV and only applies the update
 * if the current status matches one of the expected statuses.
 * Returns the updated order, or null if the status changed underneath us.
 */
export async function safeUpdateOrder(
  env: Env,
  orderId: string,
  expectedStatuses: OrderStatus[],
  updater: (order: Order) => Order
): Promise<Order | null> {
  const fresh = await getOrder(env, orderId);
  if (!fresh) return null;
  if (!expectedStatuses.includes(fresh.status)) return null;

  const updated = updater(fresh);
  await updateOrder(env, updated);
  return updated;
}

export async function findOrderByMemo(
  env: Env,
  chain: Chain,
  memo: string
): Promise<Order | null> {
  const orderId = await env.ORDERS.get(memoKey(chain, memo));
  if (!orderId) return null;
  return getOrder(env, orderId);
}

// ─── Pending list management ─────────────────────────────────────────
async function addToPendingList(env: Env, chain: Chain, orderId: string): Promise<void> {
  const list = await getPendingList(env, chain);
  if (!list.includes(orderId)) {
    list.push(orderId);
    await env.ORDERS.put(pendingListKey(chain), JSON.stringify(list));
  }
}

export async function getPendingList(env: Env, chain: Chain): Promise<string[]> {
  const raw = await env.ORDERS.get(pendingListKey(chain));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export async function removeFromPendingList(env: Env, chain: Chain, orderId: string): Promise<void> {
  const list = await getPendingList(env, chain);
  const filtered = list.filter((id) => id !== orderId);
  await env.ORDERS.put(pendingListKey(chain), JSON.stringify(filtered));
}

// ─── Confirming list management ──────────────────────────────────────
export async function addToConfirmingList(env: Env, chain: Chain, orderId: string): Promise<void> {
  const list = await getConfirmingList(env, chain);
  if (!list.includes(orderId)) {
    list.push(orderId);
    await env.ORDERS.put(confirmingListKey(chain), JSON.stringify(list));
  }
}

export async function getConfirmingList(env: Env, chain: Chain): Promise<string[]> {
  const raw = await env.ORDERS.get(confirmingListKey(chain));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export async function removeFromConfirmingList(env: Env, chain: Chain, orderId: string): Promise<void> {
  const list = await getConfirmingList(env, chain);
  const filtered = list.filter((id) => id !== orderId);
  await env.ORDERS.put(confirmingListKey(chain), JSON.stringify(filtered));
}

// ─── Confirmation recheck ────────────────────────────────────────────
/**
 * Increment confirmations on all confirming orders and return any
 * that have reached the required threshold (status set to "paid").
 * Caller is responsible for sending webhooks.
 */
export async function recheckConfirmingOrders(
  env: Env,
  chain: Chain,
  requiredConfirmations: number
): Promise<Order[]> {
  const ids = await getConfirmingList(env, chain);
  const confirmed: Order[] = [];

  for (const id of ids) {
    const order = await getOrder(env, id);
    if (!order || order.status !== "confirming") {
      await removeFromConfirmingList(env, chain, id);
      continue;
    }

    // Increment confirmations on each payment
    for (const payment of order.payments) {
      payment.confirmations++;
    }

    const minConfirmations = Math.min(...order.payments.map((p) => p.confirmations));

    if (minConfirmations >= requiredConfirmations) {
      order.status = "paid";
      order.paidAt = Date.now();
      await updateOrder(env, order);
      await removeFromConfirmingList(env, chain, id);
      confirmed.push(order);
    } else {
      await updateOrder(env, order);
    }
  }

  return confirmed;
}

// ─── Cleanup: expire old orders ──────────────────────────────────────
export async function expireOldOrders(env: Env, chain: Chain): Promise<void> {
  const ids = await getPendingList(env, chain);
  const now = Date.now();

  for (const id of ids) {
    const order = await getOrder(env, id);
    if (!order) {
      await removeFromPendingList(env, chain, id);
      continue;
    }
    // Expire both pending and partially_paid orders
    if (
      (order.status === "pending" || order.status === "partially_paid") &&
      now > order.expiresAt
    ) {
      order.status = "expired";
      await updateOrder(env, order);
      await removeFromPendingList(env, chain, id);
      await env.ORDERS.delete(memoKey(chain, order.memo));
    }
  }
}

// ─── Idempotency ─────────────────────────────────────────────────────
export async function getIdempotentOrderId(env: Env, key: string): Promise<string | null> {
  return env.ORDERS.get(idempotencyKey(key));
}

export async function saveIdempotencyKey(env: Env, key: string, orderId: string): Promise<void> {
  await env.ORDERS.put(idempotencyKey(key), orderId, { expirationTtl: ORDER_TTL });
}

// Rate limiting is now handled by Cloudflare Workers Rate Limiting binding (see wrangler.jsonc).
