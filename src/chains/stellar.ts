import type { Env, StellarPayment, Payment } from "../types";
import {
  findOrderByMemo,
  removeFromPendingList,
  addToConfirmingList,
  safeUpdateOrder,
} from "../services/store";
import { sendWebhook } from "../services/webhook";
import { sumAmounts, gte } from "../utils/decimal";
import { parseUrls, fetchWithFallback } from "../utils/fetch";

const CURSOR_KEY = "stellar:cursor";

/**
 * Poll Stellar Horizon for new payments to our address.
 *
 * Uses the payments endpoint with a cursor to only fetch new txs
 * since the last poll. Horizon returns payments in ascending order.
 */
export async function pollStellar(env: Env): Promise<void> {
  const cursor = await env.CURSORS.get(CURSOR_KEY);
  const requiredConfirmations = parseInt(env.CONFIRMATIONS_REQUIRED || "1", 10);

  const bases = parseUrls(env.HORIZON_URL);
  const path = `/accounts/${env.XLM_ADDRESS}/payments`;
  const params = new URLSearchParams({ order: "asc", limit: "50" });
  if (cursor) params.set("cursor", cursor);
  const urls = bases.map((base) => `${base.replace(/\/$/, "")}${path}?${params}`);

  let res: Response;
  try {
    res = await fetchWithFallback(urls, { headers: { Accept: "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[stellar] All Horizon endpoints failed: ${message}`);
    return;
  }

  if (!res.ok) {
    console.error(`[stellar] Horizon error: ${res.status} ${await res.text()}`);
    return;
  }

  let data: { _embedded: { records: StellarPayment[] } };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.error(`[stellar] Failed to parse Horizon response: ${err}`);
    return;
  }

  const payments = data._embedded.records;
  if (payments.length === 0) return;

  let latestCursor = cursor;

  for (const payment of payments) {
    latestCursor = payment.paging_token;

    // Only care about native XLM payments TO our address
    if (payment.to !== env.XLM_ADDRESS) continue;
    if (payment.asset_type !== "native") continue;

    // Fetch memo from payment or parent transaction
    const memo = await fetchMemoForPayment(env, payment);
    if (!memo) continue;

    const order = await findOrderByMemo(env, "xlm", memo);
    if (!order) continue;

    // Skip terminal statuses
    if (order.status === "paid" || order.status === "expired" || order.status === "cancelled") {
      continue;
    }

    // Check if this transaction was already recorded
    if (order.payments.some((p) => p.txHash === payment.transaction_hash)) {
      continue;
    }

    // Build payment record
    const newPayment: Payment = {
      from: payment.from,
      to: payment.to,
      memo,
      txHash: payment.transaction_hash,
      amount: payment.amount,
      confirmations: 1,
      detectedAt: Date.now(),
    };

    // Race-safe update: re-read and apply
    const updated = await safeUpdateOrder(
      env,
      order.id,
      ["pending", "partially_paid", "confirming"],
      (current) => {
        current.payments.push(newPayment);

        // Calculate total paid using precise decimal arithmetic
        const totalPaid = sumAmounts(current.payments.map((p) => p.amount));
        current.paidAmount = totalPaid;

        if (gte(totalPaid, current.amount)) {
          current.txHash = payment.transaction_hash;

          if (requiredConfirmations <= 1) {
            current.status = "paid";
            current.paidAt = Date.now();
          } else {
            current.status = "confirming";
          }
        } else {
          current.status = "partially_paid";
        }

        return current;
      }
    );

    if (!updated) continue;

    // Move between lists based on new status
    if (updated.status === "paid") {
      await removeFromPendingList(env, "xlm", updated.id);
      await sendWebhook(env, {
        event: "payment.confirmed",
        orderId: updated.id,
        chain: "xlm",
        expectedAmount: updated.amount,
        paidAmount: updated.paidAmount!,
        memo: updated.memo,
        txHash: updated.txHash!,
        paidAt: updated.paidAt!,
        payments: updated.payments,
        metadata: updated.metadata,
      }, { callbackUrl: updated.callbackUrl, callbackSecret: updated.callbackSecret });
      console.log(`[stellar] Payment confirmed: order=${updated.id} tx=${payment.transaction_hash}`);
    } else if (updated.status === "confirming") {
      await removeFromPendingList(env, "xlm", updated.id);
      await addToConfirmingList(env, "xlm", updated.id);
      console.log(`[stellar] Payment confirming: order=${updated.id} tx=${payment.transaction_hash}`);
    } else if (updated.status === "partially_paid") {
      await sendWebhook(env, {
        event: "payment.partial",
        orderId: updated.id,
        chain: "xlm",
        expectedAmount: updated.amount,
        paidAmount: updated.paidAmount!,
        memo: updated.memo,
        txHash: payment.transaction_hash,
        paidAt: Date.now(),
        payments: updated.payments,
        metadata: updated.metadata,
      }, { callbackUrl: updated.callbackUrl, callbackSecret: updated.callbackSecret });
      console.log(
        `[stellar] Partial payment: order=${updated.id} paid=${updated.paidAmount}/${updated.amount}`
      );
    }
  }

  // Persist cursor for next poll
  if (latestCursor && latestCursor !== cursor) {
    await env.CURSORS.put(CURSOR_KEY, latestCursor);
  }
}

/**
 * Fetch the memo from a Stellar payment.
 *
 * The payments endpoint doesn't always embed the memo directly.
 * If `memo` is not on the payment record, we fetch the parent
 * transaction to get it.
 */
async function fetchMemoForPayment(
  env: Env,
  payment: StellarPayment
): Promise<string | undefined> {
  if (payment.memo) return payment.memo;

  const bases = parseUrls(env.HORIZON_URL);
  const path = `/transactions/${payment.transaction_hash}`;
  const urls = bases.map((base) => `${base.replace(/\/$/, "")}${path}`);

  try {
    const res = await fetchWithFallback(urls, { headers: { Accept: "application/json" } });
    if (!res.ok) return undefined;

    const tx = (await res.json()) as { memo?: string; memo_type?: string };
    return tx.memo;
  } catch {
    return undefined;
  }
}
