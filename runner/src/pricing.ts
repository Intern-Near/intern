/**
 * Whole-number money and prices for the runner (01 §2: no floating point). Hyperliquid's decimal strings are read
 * exactly into scaled integers, and prices are written in Hyperliquid's format (01 §4).
 */

/**
 * Reads a decimal string ("0.06917", "722.0", "-3.625312") into an integer scaled by 10^scale. Throws if the
 * string is not a plain decimal, or has more decimals than `scale` (nothing is rounded away silently).
 */
export function parseScaled(s: string, scale: number): bigint {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(s);
  if (!m) throw new Error(`not a decimal number: ${JSON.stringify(s)}`);
  const [, sign = "", whole = "", frac = ""] = m;
  const trimmed = frac.replace(/0+$/, "");
  if (trimmed.length > scale) throw new Error(`${s} has more than ${scale} decimals`);
  const v = BigInt(whole) * 10n ** BigInt(scale) + BigInt((trimmed || "0").padEnd(scale, "0"));
  return sign === "-" ? -v : v;
}

/** Writes an integer scaled by 10^scale as a decimal string without trailing zeros ("0.069861", "143"). */
export function formatScaled(v: bigint, scale: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(scale);
  const frac = (a % base).toString().padStart(scale, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / base}${frac ? `.${frac}` : ""}`;
}

/** Number of decimal digits of a positive integer. */
function digits(v: bigint): number {
  return v.toString().length;
}

/**
 * Hyperliquid's price format for a perp (01 §4): positive, at most 5 significant figures, at most
 * `6 − szDecimals` decimal places. `pxE8` is the price × 10^8.
 */
export function pxFormatOk(pxE8: bigint, szDecimals: number): boolean {
  if (pxE8 <= 0n || szDecimals < 0 || szDecimals > 6) return false;
  if (pxE8 % 10n ** BigInt(2 + szDecimals) !== 0n) return false; // decimals
  let significant = pxE8;
  while (significant % 10n === 0n) significant /= 10n;
  return digits(significant) <= 5;
}

/**
 * The limit price of an immediate-or-cancel order: the mid moved `slippageBps` through the market (up for a buy,
 * down for a sell), then put in Hyperliquid's format. Rounding goes toward the mid, so the price is never more
 * aggressive than asked, and never past the mid. The same method as the official SDK's `_slippage_price` (mid from `allMids`, 5
 * significant figures, `6 − szDecimals` decimals), done in whole numbers.
 */
export function limitPxE8(midE8: bigint, isBuy: boolean, slippageBps: number, szDecimals: number): bigint {
  if (midE8 <= 0n) throw new Error("mid price must be positive");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error("slippage must be a whole number of basis points below 10000");
  }
  const num = midE8 * BigInt(isBuy ? 10_000 + slippageBps : 10_000 - slippageBps);
  const den = 10_000n;
  const decimalUnit = 10n ** BigInt(2 + szDecimals);
  let unit = decimalUnit;
  for (let i = 0; i < 3; i++) {
    const step = den * unit;
    const px = isBuy ? (num / step) * unit : ((num + step - 1n) / step) * unit;
    if (px > 0n && pxFormatOk(px, szDecimals)) {
      // Rounding toward the mid must not carry the price past it (only possible when the format is coarser than
      // the slippage, e.g. a price below 0.000001).
      if (isBuy ? px < midE8 : px > midE8) {
        throw new Error(
          `Hyperliquid's price format is too coarse for ${slippageBps} bps at ${formatScaled(midE8, 8)}`,
        );
      }
      return px;
    }
    // Too many significant figures at this size: widen the unit to keep 5 of them, and round again.
    const size = digits(px > 0n ? px : num / den);
    const sigUnit = 10n ** BigInt(Math.max(0, size - 5));
    // biome-ignore lint/complexity/useMathMinMax: these are bigints; Math.max does not take them
    unit = sigUnit > decimalUnit ? sigUnit : decimalUnit;
  }
  throw new Error(`no price in Hyperliquid's format near ${formatScaled(midE8, 8)}`);
}
