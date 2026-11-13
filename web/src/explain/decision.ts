import { isRecord } from "./json.ts";
import { MARKETS, type Market } from "./markets.ts";
import type { Side } from "./ranks.ts";

export type Decision =
  | { action: "SKIP" }
  | { action: "BET"; market: Market; side: Side; margin_e6: bigint; leverage: number };

const U128_MAX = (1n << 128n) - 1n;
const U32_MAX = 0xffff_ffff;
const MARKET_NAMES: ReadonlySet<string> = new Set(MARKETS.map((m) => m.market));

/** The canonical decision line of 01 §6.2 (the same text as ai-check's `decision_line`). */
export function decisionLine(roundId: number, nonce: string, d: Decision): string {
  const head = `{"v":1,"round":${roundId},"nonce":"${nonce}","action":`;
  if (d.action === "SKIP") return `${head}"skip"}`;
  return `${head}"bet","market":"${d.market}","side":"${d.side.toLowerCase()}","margin_e6":"${d.margin_e6}","leverage":${d.leverage}}`;
}

export type DecisionRead = { ok: true; decision: Decision } | { ok: false; reason: string };

/**
 * The shape part of check 5 (01 §7, `MALFORMED_DECISION`): the answer must be exactly a decision line for this
 * round and nonce. Strict by construction: parse, write back in canonical form, and require the two texts to be
 * equal. Extra spaces, another key order, extra or duplicate keys, escapes, a code fence, text before or after,
 * or a trailing newline all fail the equality.
 *
 * Open points in 01, raised with the owner (issue C): a margin of "0" is read here as a bet (test case 7 expects
 * ZERO_MARGIN, not MALFORMED); a market outside the six, a leverage of 0, and numbers too big for u128 / u32
 * are read as malformed.
 */
export function readDecisionLine(text: string, expect: { round_id: number; nonce: string }): DecisionRead {
  const bad = (reason: string): DecisionRead => ({ ok: false, reason });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (!isRecord(data)) return bad("not a JSON object");
  if (data.v !== 1) return bad("v is not 1");
  if (data.round !== expect.round_id) return bad("wrong round");
  if (data.nonce !== expect.nonce) return bad("wrong nonce");
  let decision: Decision;
  if (data.action === "skip") {
    decision = { action: "SKIP" };
  } else if (data.action === "bet") {
    const { market, side, margin_e6, leverage } = data;
    if (typeof market !== "string" || !MARKET_NAMES.has(market)) return bad("market is not one of the six");
    if (side !== "long" && side !== "short") return bad("side is not long or short");
    if (typeof margin_e6 !== "string" || !/^(0|[1-9][0-9]*)$/.test(margin_e6)) {
      return bad("margin_e6 is not a string of digits without a leading zero");
    }
    const margin = BigInt(margin_e6);
    if (margin > U128_MAX) return bad("margin_e6 does not fit in u128");
    if (typeof leverage !== "number" || !Number.isInteger(leverage) || leverage < 1 || leverage > U32_MAX) {
      return bad("leverage is not a whole number from 1 to 4294967295");
    }
    decision = {
      action: "BET",
      market: market as Market,
      side: side === "long" ? "LONG" : "SHORT",
      margin_e6: margin,
      leverage,
    };
  } else {
    return bad("action is not skip or bet");
  }
  if (decisionLine(expect.round_id, expect.nonce, decision) !== text) {
    return bad(
      "not byte-equal to the canonical line (spacing, key order, extra keys, escapes or surrounding text)",
    );
  }
  return { ok: true, decision };
}
