import type { Env, WebhookPayload } from "../types";

const WEBHOOK_TIMEOUT_MS = 10_000; // 10 seconds

/**
 * Send a signed webhook to the merchant's backend.
 *
 * Signs the payload with HMAC-SHA256 using WEBHOOK_SECRET.
 * The merchant verifies by computing the same HMAC over the raw body
 * and comparing it to the X-Signature header.
 *
 * Retries up to 3 times with exponential backoff on failure.
 * Each request has a 10-second timeout.
 */
export async function sendWebhook(
  env: Env,
  payload: WebhookPayload
): Promise<void> {
  if (!env.WEBHOOK_URL) {
    console.warn("No WEBHOOK_URL configured, skipping webhook");
    return;
  }

  const body = JSON.stringify(payload);
  const signature = await sign(body, env.WEBHOOK_SECRET);

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const res = await fetch(env.WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": signature,
          "X-Webhook-Event": payload.event,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.ok) {
        console.log(`Webhook delivered: order=${payload.orderId} event=${payload.event}`);
        return;
      }

      console.error(
        `Webhook attempt ${attempt + 1} failed: ${res.status} ${res.statusText}`
      );
    } catch (err) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Webhook attempt ${attempt + 1} error: ${message}`);
    }

    // Exponential backoff: 1s, 2s, 4s
    if (attempt < maxRetries - 1) {
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  console.error(`Webhook failed after ${maxRetries} attempts: order=${payload.orderId}`);
}

// ─── HMAC-SHA256 signing ─────────────────────────────────────────────
async function sign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Verification helper (for your backend) ─────────────────────────
// Export this as a reference — your backend should do the same:
//
//   const crypto = require('crypto');
//   function verifyWebhook(body: string, signature: string, secret: string) {
//     const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
//     return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
//   }
