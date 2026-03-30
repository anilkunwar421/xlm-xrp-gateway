import type { Env, WebhookPayload } from "../types";

const WEBHOOK_TIMEOUT_MS = 10_000; // 10 seconds

export interface WebhookTarget {
  callbackUrl?: string;
  callbackSecret?: string;
}

/**
 * Send a signed webhook to the merchant's backend.
 *
 * Uses order-level callbackUrl/callbackSecret if provided,
 * otherwise falls back to the global WEBHOOK_URL/WEBHOOK_SECRET env vars.
 * If neither is configured, the webhook is skipped.
 *
 * Signs the payload with HMAC-SHA256.
 * Retries up to 3 times with exponential backoff on failure.
 * Each request has a 10-second timeout.
 */
export async function sendWebhook(
  env: Env,
  payload: WebhookPayload,
  target?: WebhookTarget
): Promise<void> {
  const url = target?.callbackUrl || env.WEBHOOK_URL;
  const secret = target?.callbackSecret || env.WEBHOOK_SECRET;

  if (!url) {
    console.warn("No callback URL configured, skipping webhook");
    return;
  }

  const body = JSON.stringify(payload);
  const signature = secret ? await sign(body, secret) : "";

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Webhook-Event": payload.event,
        };
      if (signature) {
        headers["X-Signature"] = signature;
      }

      const res = await fetch(url, {
        method: "POST",
        headers,
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
