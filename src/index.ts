import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { api } from "./routes/orders";
import { pollStellar } from "./chains/stellar";
import { pollXrpl } from "./chains/xrpl";
import { expireOldOrders, recheckConfirmingOrders } from "./services/store";
import { sendWebhook } from "./services/webhook";

// ─── App Types ───────────────────────────────────────────────────────
type AppBindings = {
  Bindings: Env;
  Variables: { requestId: string };
};

const app = new Hono<AppBindings>();

// ─── Request logging middleware ──────────────────────────────────────
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);

  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  console.log(
    `[http] ${requestId.slice(0, 8)} ${c.req.method} ${c.req.path} → ${c.res.status} (${duration}ms)`
  );
});

// ─── CORS — restricted by ALLOWED_ORIGINS env var ────────────────────
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      const allowed = (c.env as Env).ALLOWED_ORIGINS;
      if (!allowed || allowed === "*") return origin;
      const origins = allowed.split(",").map((s: string) => s.trim());
      return origins.includes(origin) ? origin : "";
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Idempotency-Key"],
  })
);

// ─── Health check ────────────────────────────────────────────────────
app.get("/", (c) => c.json({ status: "ok", service: "crypto-checkout" }));

// ─── Mount API routes ────────────────────────────────────────────────
app.route("/api", api);

// ─── 404 fallback ────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: "Not found" }, 404));

// ─── Error handler ───────────────────────────────────────────────────
app.onError((err, c) => {
  console.error(`[error] ${err.message}`, err.stack);
  return c.json({ error: "Internal server error" }, 500);
});

// ─── Export ──────────────────────────────────────────────────────────
export default {
  fetch: app.fetch,

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await runPollers(env);
  },
};

// ─── Cron logic ──────────────────────────────────────────────────────
async function runPollers(env: Env): Promise<void> {
  console.log(`[cron] Polling chains at ${new Date().toISOString()}`);
  const requiredConfirmations = parseInt(env.CONFIRMATIONS_REQUIRED || "1", 10);

  const results = await Promise.allSettled([
    pollStellar(env),
    pollXrpl(env),
    expireOldOrders(env, "xlm"),
    expireOldOrders(env, "xrp"),
    processConfirmations(env, "xlm", requiredConfirmations),
    processConfirmations(env, "xrp", requiredConfirmations),
  ]);

  const labels = [
    "Stellar poll",
    "XRPL poll",
    "XLM expiry",
    "XRP expiry",
    "XLM confirmations",
    "XRP confirmations",
  ];

  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`[cron] ${labels[i]} failed:`, result.reason);
    }
  }
}

async function processConfirmations(
  env: Env,
  chain: "xlm" | "xrp",
  requiredConfirmations: number
): Promise<void> {
  const confirmed = await recheckConfirmingOrders(env, chain, requiredConfirmations);

  for (const order of confirmed) {
    await sendWebhook(env, {
      event: "payment.confirmed",
      orderId: order.id,
      chain: order.chain,
      expectedAmount: order.amount,
      paidAmount: order.paidAmount!,
      memo: order.memo,
      txHash: order.txHash!,
      paidAt: order.paidAt!,
      payments: order.payments,
      metadata: order.metadata,
    }, { callbackUrl: order.callbackUrl, callbackSecret: order.callbackSecret });
    console.log(`[cron] Confirmed after ${requiredConfirmations} checks: order=${order.id}`);
  }
}
