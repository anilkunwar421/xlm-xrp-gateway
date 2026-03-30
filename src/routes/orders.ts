import { Hono } from "hono";
import type { Env, CreateOrderRequest, CreateOrderResponse, OrderStatusResponse } from "../types";
import {
  generateUniqueMemo,
  saveOrder,
  getOrder,
  removeFromPendingList,
  getIdempotentOrderId,
  saveIdempotencyKey,
  safeUpdateOrder,
} from "../services/store";

const api = new Hono<{ Bindings: Env }>();

// ─── API key authentication middleware ───────────────────────────────
api.use("/*", async (c, next) => {
  const apiKey = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!c.env.API_KEY || !apiKey || apiKey !== c.env.API_KEY) {
    return c.json({ error: "Unauthorized. Provide a valid API key via Authorization: Bearer <key>" }, 401);
  }
  await next();
});

// ─── Rate limiting middleware (Cloudflare Workers binding — atomic) ──
api.use("/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
  const { success } = await c.env.RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }
  await next();
});

// ─── POST /api/orders ────────────────────────────────────────────────
api.post("/orders", async (c) => {
  let body: CreateOrderRequest;
  try {
    body = await c.req.json<CreateOrderRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── Input validation ──
  if (!body || typeof body !== "object") {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  if (!body.chain || !["xlm", "xrp"].includes(body.chain)) {
    return c.json({ error: "chain must be 'xlm' or 'xrp'" }, 400);
  }
  if (!body.amount || typeof body.amount !== "string") {
    return c.json({ error: "amount must be a string" }, 400);
  }
  const parsedAmount = parseFloat(body.amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    return c.json({ error: "amount must be a positive number" }, 400);
  }
  if (!/^\d+(\.\d+)?$/.test(body.amount)) {
    return c.json({ error: "amount must be a valid decimal string (e.g. '10.5')" }, 400);
  }
  if (body.expiresInMinutes !== undefined) {
    if (typeof body.expiresInMinutes !== "number" || body.expiresInMinutes < 1 || body.expiresInMinutes > 1440) {
      return c.json({ error: "expiresInMinutes must be between 1 and 1440" }, 400);
    }
  }
  if (body.metadata !== undefined && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
    return c.json({ error: "metadata must be a key-value object" }, 400);
  }
  if (body.callbackUrl !== undefined) {
    if (typeof body.callbackUrl !== "string") {
      return c.json({ error: "callbackUrl must be a string" }, 400);
    }
    try {
      const parsed = new URL(body.callbackUrl);
      if (parsed.protocol !== "https:") {
        return c.json({ error: "callbackUrl must use HTTPS" }, 400);
      }
    } catch {
      return c.json({ error: "callbackUrl must be a valid URL" }, 400);
    }
  }
  if (body.callbackSecret !== undefined && typeof body.callbackSecret !== "string") {
    return c.json({ error: "callbackSecret must be a string" }, 400);
  }

  const env = c.env;
  const chain = body.chain;

  // ── Idempotency check ──
  if (body.idempotencyKey) {
    const existingOrderId = await getIdempotentOrderId(env, body.idempotencyKey);
    if (existingOrderId) {
      const existingOrder = await getOrder(env, existingOrderId);
      if (existingOrder) {
        const address = chain === "xlm" ? env.XLM_ADDRESS : env.XRP_ADDRESS;
        const isXlm = chain === "xlm";
        return c.json({
          orderId: existingOrder.id,
          chain: existingOrder.chain,
          address,
          memo: existingOrder.memo,
          amount: existingOrder.amount,
          expiresAt: existingOrder.expiresAt,
          paymentInstructions: {
            address,
            ...(isXlm ? { memo: existingOrder.memo } : { destinationTag: existingOrder.memo }),
            amount: existingOrder.amount,
            currency: chain.toUpperCase(),
            note: isXlm
              ? `Send exactly ${existingOrder.amount} XLM to ${address} with MEMO: ${existingOrder.memo}`
              : `Send exactly ${existingOrder.amount} XRP to ${address} with DESTINATION TAG: ${existingOrder.memo}`,
          },
          _idempotent: true,
        }, 200);
      }
    }
  }

  const expiresInMs = (body.expiresInMinutes ?? 60) * 60 * 1000; // default 1 hour
  const now = Date.now();

  const memo = await generateUniqueMemo(env, chain);
  const orderId = crypto.randomUUID();

  const order = {
    id: orderId,
    chain,
    amount: body.amount,
    memo,
    status: "pending" as const,
    createdAt: now,
    expiresAt: now + expiresInMs,
    payments: [],
    metadata: body.metadata,
    idempotencyKey: body.idempotencyKey,
    callbackUrl: body.callbackUrl,
    callbackSecret: body.callbackSecret,
  };

  await saveOrder(env, order);

  // Save idempotency mapping
  if (body.idempotencyKey) {
    await saveIdempotencyKey(env, body.idempotencyKey, orderId);
  }

  const address = chain === "xlm" ? env.XLM_ADDRESS : env.XRP_ADDRESS;

  const response: CreateOrderResponse = {
    orderId,
    chain,
    address,
    memo,
    amount: body.amount,
    expiresAt: order.expiresAt,
  };

  console.log(`[orders] Created: id=${orderId} chain=${chain} amount=${body.amount} memo=${memo}`);

  const isXlm = chain === "xlm";
  return c.json({
    ...response,
    paymentInstructions: {
      address,
      ...(isXlm ? { memo } : { destinationTag: memo }),
      amount: body.amount,
      currency: chain.toUpperCase(),
      note: isXlm
        ? `Send exactly ${body.amount} XLM to ${address} with MEMO: ${memo}`
        : `Send exactly ${body.amount} XRP to ${address} with DESTINATION TAG: ${memo}`,
    },
  }, 201);
});

// ─── GET /api/orders/:orderId ────────────────────────────────────────
api.get("/orders/:orderId", async (c) => {
  const orderId = c.req.param("orderId");

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  const order = await getOrder(c.env, orderId);
  if (!order) {
    return c.json({ error: "Order not found" }, 404);
  }

  // Race-safe expiry check: only expire if still in an expirable status
  if (
    (order.status === "pending" || order.status === "partially_paid") &&
    Date.now() > order.expiresAt
  ) {
    const expired = await safeUpdateOrder(
      c.env,
      order.id,
      ["pending", "partially_paid"],
      (o) => { o.status = "expired"; return o; }
    );
    if (expired) {
      await removeFromPendingList(c.env, order.chain, order.id);
      order.status = "expired";
    }
  }

  const response: OrderStatusResponse = {
    orderId: order.id,
    status: order.status,
    chain: order.chain,
    amount: order.amount,
    memo: order.memo,
    payments: order.payments,
    txHash: order.txHash,
    paidAt: order.paidAt,
    paidAmount: order.paidAmount,
  };

  return c.json(response);
});

// ─── POST /api/orders/:orderId/cancel ────────────────────────────────
api.post("/orders/:orderId/cancel", async (c) => {
  const orderId = c.req.param("orderId");

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  // Race-safe cancel: only if still pending or partially_paid
  const cancelled = await safeUpdateOrder(
    c.env,
    orderId,
    ["pending", "partially_paid"],
    (order) => { order.status = "cancelled"; return order; }
  );

  if (!cancelled) {
    const order = await getOrder(c.env, orderId);
    if (!order) return c.json({ error: "Order not found" }, 404);
    return c.json({ error: `Cannot cancel order with status: ${order.status}` }, 400);
  }

  await removeFromPendingList(c.env, cancelled.chain, cancelled.id);

  return c.json({ orderId: cancelled.id, status: "cancelled" });
});

export { api };
