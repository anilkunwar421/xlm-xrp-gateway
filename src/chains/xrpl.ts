import type { Env, Payment } from "../types";
import {
  findOrderByMemo,
  removeFromPendingList,
  addToConfirmingList,
  safeUpdateOrder,
} from "../services/store";
import { sendWebhook } from "../services/webhook";
import { sumAmounts, gte, dropsToXrp } from "../utils/decimal";
import { parseUrls, fetchWithFallback } from "../utils/fetch";

const CURSOR_KEY = "xrpl:ledger_index";

/**
 * Poll XRPL for new transactions to our address.
 *
 * Uses the `account_tx` method and tracks the last seen ledger index
 * to only process new transactions on each poll.
 */
export async function pollXrpl(env: Env): Promise<void> {
  const lastLedger = await env.CURSORS.get(CURSOR_KEY);
  const ledgerMin = lastLedger ? parseInt(lastLedger, 10) + 1 : -1;
  const requiredConfirmations = parseInt(env.CONFIRMATIONS_REQUIRED || "1", 10);

  const body = {
    method: "account_tx",
    params: [
      {
        account: env.XRP_ADDRESS,
        ledger_index_min: ledgerMin,
        ledger_index_max: -1,
        limit: 50,
        forward: true,
      },
    ],
  };

  const urls = parseUrls(env.XRPL_URL);

  let res: Response;
  try {
    res = await fetchWithFallback(urls, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[xrpl] All RPC endpoints failed: ${message}`);
    return;
  }

  if (!res.ok) {
    console.error(`[xrpl] RPC error: ${res.status} ${await res.text()}`);
    return;
  }

  let data: {
    result: {
      transactions?: Array<{
        tx: {
          hash: string;
          Account: string;
          TransactionType: string;
          Amount: string | { value: string; currency: string; issuer: string };
          Destination: string;
          DestinationTag?: number;
        };
        meta: {
          TransactionResult: string;
          delivered_amount?: string | { value: string; currency: string };
        };
        validated: boolean;
      }>;
      ledger_index_max?: number;
      status: string;
    };
  };

  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.error(`[xrpl] Failed to parse RPC response: ${err}`);
    return;
  }

  if (data.result.status !== "success") {
    console.error("[xrpl] account_tx failed:", JSON.stringify(data.result));
    return;
  }

  const transactions = data.result.transactions ?? [];

  for (const entry of transactions) {
    const { tx, meta } = entry;

    // Only process validated Payment transactions to our address
    if (!entry.validated) continue;
    if (tx.TransactionType !== "Payment") continue;
    if (tx.Destination !== env.XRP_ADDRESS) continue;
    if (meta.TransactionResult !== "tesSUCCESS") continue;
    if (tx.DestinationTag === undefined) continue;

    const tag = tx.DestinationTag.toString();

    // Only handle native XRP (Amount is a string in drops)
    if (typeof tx.Amount !== "string") continue;

    const order = await findOrderByMemo(env, "xrp", tag);
    if (!order) continue;

    // Skip terminal statuses
    if (order.status === "paid" || order.status === "expired" || order.status === "cancelled") {
      continue;
    }

    // Check if this transaction was already recorded
    if (order.payments.some((p) => p.txHash === tx.hash)) {
      continue;
    }

    // Convert drops to XRP using precise integer arithmetic
    const deliveredDrops =
      typeof meta.delivered_amount === "string"
        ? meta.delivered_amount
        : tx.Amount;
    const paidXrp = dropsToXrp(deliveredDrops);

    // Build payment record
    const newPayment: Payment = {
      from: tx.Account,
      to: tx.Destination,
      memo: tag,
      txHash: tx.hash,
      amount: paidXrp,
      confirmations: 1,
      detectedAt: Date.now(),
    };

    // Race-safe update
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
          current.txHash = tx.hash;

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
      await removeFromPendingList(env, "xrp", updated.id);
      await sendWebhook(env, {
        event: "payment.confirmed",
        orderId: updated.id,
        chain: "xrp",
        expectedAmount: updated.amount,
        paidAmount: updated.paidAmount!,
        memo: updated.memo,
        txHash: updated.txHash!,
        paidAt: updated.paidAt!,
        payments: updated.payments,
        metadata: updated.metadata,
      });
      console.log(`[xrpl] Payment confirmed: order=${updated.id} tx=${tx.hash}`);
    } else if (updated.status === "confirming") {
      await removeFromPendingList(env, "xrp", updated.id);
      await addToConfirmingList(env, "xrp", updated.id);
      console.log(`[xrpl] Payment confirming: order=${updated.id} tx=${tx.hash}`);
    } else if (updated.status === "partially_paid") {
      await sendWebhook(env, {
        event: "payment.partial",
        orderId: updated.id,
        chain: "xrp",
        expectedAmount: updated.amount,
        paidAmount: updated.paidAmount!,
        memo: updated.memo,
        txHash: tx.hash,
        paidAt: Date.now(),
        payments: updated.payments,
        metadata: updated.metadata,
      });
      console.log(
        `[xrpl] Partial payment: order=${updated.id} paid=${updated.paidAmount}/${updated.amount}`
      );
    }
  }

  // Update cursor to the latest ledger we've seen
  if (data.result.ledger_index_max) {
    await env.CURSORS.put(CURSOR_KEY, data.result.ledger_index_max.toString());
  }
}
