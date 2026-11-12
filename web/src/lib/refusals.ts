import type { RefusalCode } from "../chain/types";
import { pct, usd } from "./format";

type Numbers = { asked: string | null; limit: string | null };

const dollars = (v: string | null) => (v === null ? "?" : usd(v));
const plain = (v: string | null) => v ?? "?";
const seconds = (v: string | null) => (v === null ? "?" : `${Math.round(Number(v) / 1000)} s`);
const percent = (v: string | null) => (v === null ? "?" : pct(Number(v)));

/** A sentence in three parts, so the number the Intern asked for can be circled. */
export type Parts = { before: string; asked: string | null; after: string };

const whole = (text: string): Parts => ({ before: text, asked: null, after: "" });

/**
 * One plain sentence per NOPE reason. The same string is used on the feed, the refusal
 * page, the share card, the toast and for screen readers. Source: 04-FRONTEND.md section 7.
 */
const SENTENCES: Record<RefusalCode, (n: Numbers) => Parts> = {
  OUTSIDE_WINDOW: () => whole("Tried to bet outside betting hours."),
  FIRED: () => whole("Tried to bet after being fired."),
  BAD_MODEL_SIGNATURE: () => whole("The answer was not signed by the Intern's AI model."),
  WRONG_RULEBOOK: () => whole("The AI was not shown today's rules."),
  MALFORMED_DECISION: () => whole("The answer was not a clean bet slip."),
  NOT_ON_LIST: () => whole("Asked for a coin this rank may not bet on."),
  SHORT_NOT_UNLOCKED: () => whole("Asked to bet on a fall. Only a Trader may."),
  ZERO_MARGIN: (n) => ({ before: "Asked for a bet of ", asked: dollars(n.asked), after: `. The smallest bet is ${dollars(n.limit)}.` }),
  OVER_LEVERAGE: (n) => ({ before: "Asked for ", asked: `${plain(n.asked)}x`, after: `. This rank may use ${plain(n.limit)}x.` }),
  TOO_MANY_TRADES: (n) => ({ before: "Asked for bet number ", asked: plain(n.asked), after: ` today. This rank gets ${plain(n.limit)}.` }),
  OVER_TRADE_LIMIT: (n) => ({ before: "Asked to put ", asked: dollars(n.asked), after: ` into one bet. This rank may use ${dollars(n.limit)}.` }),
  OVER_ROUND_LIMIT: (n) => ({ before: "That would put ", asked: dollars(n.asked), after: ` at risk today. This rank may risk ${dollars(n.limit)}.` }),
  BAD_QUOTE_SIGNATURE: () => whole("The price quote for moving the money was not genuine."),
  STALE_QUOTE: (n) => ({ before: "The price quote was ", asked: seconds(n.asked), after: ` old. It must be under ${seconds(n.limit)}.` }),
  QUOTE_MISMATCH: () => whole("The price quote was for a different amount or a different account."),
  TOO_EXPENSIVE: (n) => ({ before: "Moving the money would cost ", asked: percent(n.asked), after: `. The most allowed is ${percent(n.limit)}.` }),
};

export function refusalParts(code: RefusalCode, numbers: Numbers): Parts {
  return SENTENCES[code](numbers);
}

export function refusalSentence(code: RefusalCode, numbers: Numbers): string {
  const p = SENTENCES[code](numbers);
  return p.before + (p.asked ?? "") + p.after;
}

/** The five check lights, in the order the program runs its sixteen checks. */
export const LIGHTS = [
  { name: "On time and employed", codes: ["OUTSIDE_WINDOW", "FIRED"] },
  { name: "Really the AI", codes: ["BAD_MODEL_SIGNATURE", "WRONG_RULEBOOK", "MALFORMED_DECISION"] },
  { name: "Allowed coin and direction", codes: ["NOT_ON_LIST", "SHORT_NOT_UNLOCKED"] },
  { name: "Fits the rank", codes: ["ZERO_MARGIN", "OVER_LEVERAGE", "TOO_MANY_TRADES", "OVER_TRADE_LIMIT", "OVER_ROUND_LIMIT"] },
  { name: "Funding quote", codes: ["BAD_QUOTE_SIGNATURE", "STALE_QUOTE", "QUOTE_MISMATCH", "TOO_EXPENSIVE"] },
] as const satisfies readonly { name: string; codes: readonly RefusalCode[] }[];

/** Index of the light that fails for this code. */
export function lightFor(code: RefusalCode): number {
  return LIGHTS.findIndex((l) => (l.codes as readonly RefusalCode[]).includes(code));
}
