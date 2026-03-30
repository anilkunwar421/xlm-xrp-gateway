/**
 * Precise decimal arithmetic using BigInt to avoid IEEE 754 rounding errors.
 * All amounts are scaled to 7 decimal places (covers XLM stroops and XRP drops).
 */

const PRECISION = 7;
const SCALE = 10n ** BigInt(PRECISION);

/** Convert a decimal string like "10.5" to a scaled BigInt (105000000n). */
function toBigUnits(decimalStr: string): bigint {
  const [whole = "0", frac = ""] = decimalStr.split(".");
  const paddedFrac = frac.padEnd(PRECISION, "0").slice(0, PRECISION);
  return BigInt(whole) * SCALE + BigInt(paddedFrac);
}

/** Convert a scaled BigInt back to a decimal string. */
function fromBigUnits(units: bigint): string {
  const whole = units / SCALE;
  const fracRaw = (units % SCALE).toString().padStart(PRECISION, "0");
  const frac = fracRaw.replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Sum an array of decimal strings with full precision. */
export function sumAmounts(amounts: string[]): string {
  const total = amounts.reduce((sum, a) => sum + toBigUnits(a), 0n);
  return fromBigUnits(total);
}

/** Returns true if a >= b using precise comparison. */
export function gte(a: string, b: string): boolean {
  return toBigUnits(a) >= toBigUnits(b);
}

/** Convert XRP drops (integer string) to XRP decimal string without floating-point. */
export function dropsToXrp(drops: string): string {
  const d = BigInt(drops);
  const whole = d / 1_000_000n;
  const fracRaw = (d % 1_000_000n).toString().padStart(6, "0");
  const frac = fracRaw.replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
