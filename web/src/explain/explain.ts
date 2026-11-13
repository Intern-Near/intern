import type { Decision } from "./decision.ts";
import { dollarLimit, MIN_NOTIONAL_E6, RANKS, type RankName } from "./ranks.ts";
import { HL_MAX_LEVERAGE, limitBase, REFUSAL_CODES, type RoundState, rankChecks } from "./rules.ts";

/**
 * "Why NOPE?": the verdict of checks 6 to 12 (01-SHARED-INTERFACE.md v1.5 §7) for one proposed bet, with the rule
 * in plain words, where 01 says it, and the numbers the deciding check compared.
 *
 * The verdict is rules.ts's `rankChecks`, never worked out again here. This file only explains it: it lists each
 * check with its numbers (every limit from ranks.ts and rules.ts; none is typed here), and it refuses to explain a
 * verdict its own list disagrees with (that would be a bug here, and a wrong reason is worse than none). The round's
 * state comes from the caller; src/quote.ts builds it from the contract's views (and the rulebook, rulebook.ts).
 *
 * Browser-safe on purpose (no `node:` import, no Node global), so the website can bundle it; test/explain.test.ts
 * walks its imports to keep it so.
 */

/** Checks 6 to 12 in 01 §7's order: REFUSAL_CODES[5] is check 6, REFUSAL_CODES[11] is check 12. */
export type RankCode = (typeof REFUSAL_CODES)[5 | 6 | 7 | 8 | 9 | 10 | 11];
const RANK_CODES = REFUSAL_CODES.slice(5, 12) as readonly RankCode[];

/** 01 §7's number for a code: its place in the list, from 1. */
export function checkNumber(code: RankCode): number {
  return REFUSAL_CODES.indexOf(code) + 1;
}

/** Each check's rule in plain words and where 01 says it. No numbers here: they come from the state. */
export const RULES: Readonly<Record<RankCode, { rule: string; section: string }>> = {
  NOT_ON_LIST: {
    rule: "The market must be on the current rank's list of markets.",
    section: "01 §7 check 6; the lists are in §3",
  },
  SHORT_NOT_UNLOCKED: {
    rule: "A short bet needs a rank that allows short.",
    section: "01 §7 check 7; the sides are in §3",
  },
  ZERO_MARGIN: {
    rule:
      "The margin must be above 0, and the notional (margin × leverage) must be at least min_notional, because " +
      "Hyperliquid refuses orders below its own minimum.",
    section: "01 §7 check 8; min_notional is in §3 (1.2)",
  },
  OVER_LEVERAGE: {
    rule:
      "The leverage must not be above the rank's max_leverage. A bet judged as the round's long-shot ticket may go " +
      "up to the ticket's cap instead, lowered to what Hyperliquid allows on that market.",
    section: "01 §7 check 9; §3; the long shot is §9.7 (1.5)",
  },
  TOO_MANY_TRADES: {
    rule: "Each rank allows max_bets bets per round; once they are used, another bet is refused.",
    section: "01 §7 check 10; §3",
  },
  OVER_TRADE_LIMIT: {
    rule: "One bet's margin must not be above the per-bet limit: per_bet_bps of the limit base, rounded down.",
    section: "01 §7 check 11; the limit base is in §3 (1.1)",
  },
  OVER_ROUND_LIMIT: {
    rule:
      "The margin already at risk this round plus this bet's margin must not be above the per-round limit: " +
      "per_round_bps of the limit base, rounded down.",
    section: "01 §7 check 12; the limit base is in §3 (1.1)",
  },
};

export type Outcome = "pass" | "fail" | "not reached" | "not applied";

/** One of checks 6 to 12 for the bet. */
export interface Step {
  check: number;
  code: RankCode;
  outcome: Outcome;
  /** For "not reached": what this check alone would say. The program stops at the first failure (01 §7). */
  would: "pass" | "fail" | "not applied" | null;
  /** What the check compared, in plain words with the numbers. */
  detail: string;
  /** 01 §7's `asked` and `limit` for this check, as decimal strings; null for checks 6 and 7, and when not applied. */
  asked: string | null;
  limit: string | null;
}

export interface Explanation {
  verdict: "YES" | "SKIP" | "NOPE";
  /** The NOPE's code and check number (6 to 12); null otherwise. */
  code: RankCode | null;
  check: number | null;
  /** 01 §7's `asked` and `limit`, exactly as rankChecks gives them (and as the contract records them). */
  asked: string | null;
  limit: string | null;
  /** margin × leverage for a bet; null for a skip. */
  notional_e6: string | null;
  /** True when the bet is judged as the round's long-shot ticket (01 1.5 §7): it has the ticket's shape and passed 6 to 8. */
  long_shot: boolean;
  /** The deciding rule in plain words and its 01 section (for YES and SKIP, what passing means). */
  rule: string;
  section: string;
  /** The numbers the deciding check compared (for YES, the notional), in words. Null for checks 6 and 7, and SKIP. */
  numbers: string | null;
  /** Where the deciding check's limit comes from (for YES, the dollar limits). Null when there is no limit. */
  limit_from: string | null;
  /** Checks 6 to 12 in order (empty for a skip). */
  steps: Step[];
}

// ---------------------------------------------------------------- words for numbers

const groups = (n: bigint): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Dollars from 6-decimal units, exact: 20000000 is "$20.00", 17997883 is "$17.997883", -72416 is "-$0.072416". */
export function usd(e6: bigint): string {
  const neg = e6 < 0n;
  const a = neg ? -e6 : e6;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${neg ? "-" : ""}$${groups(a / 1_000_000n)}.${frac}`;
}

/** Basis points as a percentage: 200 is "2%", 50 is "0.5%". */
const pct = (bps: number): string => `${bps / 100}%`;

const ranksAllowing = (has: (r: RankName) => boolean): string =>
  (Object.keys(RANKS) as RankName[]).filter(has).join(", ") || "none";

/** Where the dollar limits come from: the limit base of 01 §3 (1.1). */
function baseWords(s: RoundState): string {
  return (
    `The limit base is ${usd(limitBase(s))}: the smaller of the pool when the round opened ` +
    `(${usd(s.brave_at_open_e6)}) and the pool now (${usd(s.brave_now_e6)}), so a limit is never sized on money ` +
    "that has left (01 §3, 1.1)."
  );
}

/** "The per-bet limit $20.00 is 2% (INTERN's per_bet_bps 200, 01 §3) of the limit base, rounded down." */
function dollarWords(s: RoundState, which: "per_bet" | "per_round"): string {
  const l = RANKS[s.rank];
  const bps = which === "per_bet" ? l.per_bet_bps : l.per_round_bps;
  const name = which === "per_bet" ? "per-bet" : "per-round";
  return (
    `The ${name} limit ${usd(dollarLimit(limitBase(s), bps))} is ${pct(bps)} (${s.rank}'s ${which}_bps ${bps}, ` +
    "01 §3) of the limit base, rounded down."
  );
}

// ---------------------------------------------------------------- the checks, one by one

type BetDecision = Extract<Decision, { action: "BET" }>;

interface Alone {
  code: RankCode;
  result: "pass" | "fail" | "not applied";
  detail: string;
  asked: bigint | number | null;
  limit: bigint | number | null;
}

/** Whether a bet is judged as the round's long-shot ticket: rankChecks' own condition (01 1.5 §7). */
function isTicket(s: RoundState, d: BetDecision): boolean {
  return (
    s.ticket !== undefined && d.margin_e6 === s.ticket.margin_e6 && d.leverage > RANKS[s.rank].max_leverage
  );
}

/** The ticket's leverage cap for this market: the ticket's own, lowered to Hyperliquid's (rules.ts's numbers). */
function ticketCap(s: RoundState, d: BetDecision): { cap: number; hl: number; ticket: number } {
  const hl = HL_MAX_LEVERAGE[d.market] ?? 1;
  const ticket = s.ticket?.max_leverage ?? 0;
  return { cap: Math.min(ticket, hl), hl, ticket };
}

function ticketCapWords(s: RoundState, d: BetDecision): string {
  const t = ticketCap(s, d);
  return (
    `The ticket's cap ${t.cap}x: the smaller of the ticket's ${t.ticket}x (the rulebook's long_shot line) and ` +
    `Hyperliquid's ${t.hl}x on ${d.market} (01 §7 and §9.7, 1.5).`
  );
}

/** Each of checks 6 to 12 on its own, as if the ones before it had passed. */
function alone(s: RoundState, d: BetDecision): Alone[] {
  const rank = s.rank;
  const l = RANKS[rank];
  const margin = d.margin_e6;
  const notional = margin * BigInt(d.leverage);
  const min = s.min_notional_e6 ?? MIN_NOTIONAL_E6;
  const base = limitBase(s);
  const perBet = dollarLimit(base, l.per_bet_bps);
  const perRound = dollarLimit(base, l.per_round_bps);
  const after = s.at_risk_e6 + margin;
  const side = d.side.toLowerCase();
  const sides = l.sides.map((x) => x.toLowerCase()).join(", ");
  const result = (ok: boolean) => (ok ? "pass" : "fail");

  const onList = l.markets.includes(d.market);
  const sideOk = l.sides.includes(d.side);
  const bigEnough = margin !== 0n && notional >= min;
  const out: Alone[] = [
    {
      code: "NOT_ON_LIST",
      result: result(onList),
      detail: onList
        ? `${d.market} is on ${rank}'s list (${l.markets.join(", ")})`
        : `${d.market} is not on ${rank}'s list (${l.markets.join(", ")}); ranks that allow ${d.market}: ` +
          ranksAllowing((r) => RANKS[r].markets.includes(d.market)),
      asked: null,
      limit: null,
    },
    {
      code: "SHORT_NOT_UNLOCKED",
      result: result(sideOk),
      detail: sideOk
        ? `${side} is allowed at ${rank} (sides: ${sides})`
        : `${side} is not allowed at ${rank} (sides: ${sides}); ranks that allow ${side}: ` +
          ranksAllowing((r) => RANKS[r].sides.includes(d.side)),
      asked: null,
      limit: null,
    },
    {
      code: "ZERO_MARGIN",
      result: result(bigEnough),
      detail:
        margin === 0n
          ? `the margin is ${usd(0n)}: nothing would be at risk (min_notional ${usd(min)})`
          : `notional ${usd(notional)} (margin ${usd(margin)} × ${d.leverage}) is ` +
            `${bigEnough ? "at least" : "under"} min_notional ${usd(min)}`,
      asked: notional,
      limit: min,
    },
  ];

  if (isTicket(s, d)) {
    const { cap } = ticketCap(s, d);
    const ok = d.leverage <= cap;
    out.push(
      {
        code: "OVER_LEVERAGE",
        result: result(ok),
        detail:
          `judged as the round's long-shot ticket (margin exactly ${usd(s.ticket?.margin_e6 ?? 0n)} and leverage ` +
          `above ${rank}'s ${l.max_leverage}x): ${d.leverage}x is ${ok ? "within" : "above"} the ticket's cap ${cap}x`,
        asked: d.leverage,
        limit: cap,
      },
      {
        code: "TOO_MANY_TRADES",
        result: "not applied",
        detail: "does not apply to the long-shot ticket: it is one extra bet (01 §7, 1.5)",
        asked: null,
        limit: null,
      },
      {
        code: "OVER_TRADE_LIMIT",
        result: "not applied",
        detail: "does not apply to the long-shot ticket: its margin is fixed (01 §7, 1.5)",
        asked: null,
        limit: null,
      },
    );
  } else {
    const levOk = d.leverage <= l.max_leverage;
    const left = s.bets_used < l.max_bets;
    const betOk = margin <= perBet;
    const near =
      s.ticket !== undefined && margin !== s.ticket.margin_e6 && !levOk
        ? `; this round has a long-shot ticket, but only a margin of exactly ${usd(s.ticket.margin_e6)} is judged as it`
        : "";
    out.push(
      {
        code: "OVER_LEVERAGE",
        result: result(levOk),
        detail: `leverage ${d.leverage}x is ${levOk ? "within" : "above"} ${rank}'s max_leverage ${l.max_leverage}x${near}`,
        asked: d.leverage,
        limit: l.max_leverage,
      },
      {
        code: "TOO_MANY_TRADES",
        result: result(left),
        detail: left
          ? `this would be bet ${s.bets_used + 1} of ${rank}'s ${l.max_bets} this round`
          : `${rank} allows ${l.max_bets} bet${l.max_bets === 1 ? "" : "s"} per round and ${s.bets_used} ` +
            `${s.bets_used === 1 ? "is" : "are"} used: this would be bet ${s.bets_used + 1}` +
            (s.bets_used > l.max_bets
              ? " (after a demotion the count can be above the new rank's, 01 §9.2)"
              : ""),
        asked: s.bets_used + 1,
        limit: l.max_bets,
      },
      {
        code: "OVER_TRADE_LIMIT",
        result: result(betOk),
        detail: `margin ${usd(margin)} is ${betOk ? "within" : "above"} the per-bet limit ${usd(perBet)}`,
        asked: margin,
        limit: perBet,
      },
    );
  }
  const roundOk = after <= perRound;
  out.push({
    code: "OVER_ROUND_LIMIT",
    result: result(roundOk),
    detail:
      `at risk this round ${usd(s.at_risk_e6)} + this margin ${usd(margin)} = ${usd(after)}, ` +
      `${roundOk ? "within" : "above"} the per-round limit ${usd(perRound)}`,
    asked: after,
    limit: perRound,
  });
  return out;
}

/** Where the deciding check's limit comes from, in words, from the same state and tables. */
function limitFrom(s: RoundState, d: BetDecision, code: RankCode): string | null {
  const l = RANKS[s.rank];
  switch (code) {
    case "NOT_ON_LIST":
    case "SHORT_NOT_UNLOCKED":
      return null;
    case "ZERO_MARGIN":
      return `min_notional ${usd(s.min_notional_e6 ?? MIN_NOTIONAL_E6)}, the program's constant (01 §3, 1.2).`;
    case "OVER_LEVERAGE":
      return isTicket(s, d) ? ticketCapWords(s, d) : `${s.rank}'s max_leverage, ${l.max_leverage}x (01 §3).`;
    case "TOO_MANY_TRADES":
      return `${s.rank}'s max_bets, ${l.max_bets} per round (01 §3).`;
    case "OVER_TRADE_LIMIT":
      return `${dollarWords(s, "per_bet")} ${baseWords(s)}`;
    case "OVER_ROUND_LIMIT":
      return `${dollarWords(s, "per_round")} ${baseWords(s)}`;
  }
}

const NAMES: Readonly<Record<RankCode, { asked: string; limit: string; money: boolean }>> = {
  NOT_ON_LIST: { asked: "", limit: "", money: false },
  SHORT_NOT_UNLOCKED: { asked: "", limit: "", money: false },
  ZERO_MARGIN: { asked: "the notional", limit: "min_notional", money: true },
  OVER_LEVERAGE: { asked: "the leverage", limit: "the leverage cap", money: false },
  TOO_MANY_TRADES: { asked: "bets_used + 1", limit: "max_bets", money: false },
  OVER_TRADE_LIMIT: { asked: "the margin", limit: "the per-bet limit", money: true },
  OVER_ROUND_LIMIT: { asked: "at risk + margin", limit: "the per-round limit", money: true },
};

/** "asked 20000001 (the margin, $20.000001) against limit 20000000 (the per-bet limit, $20.00)". */
function numbersOf(code: RankCode, asked: string | null, limit: string | null): string | null {
  if (asked === null || limit === null) return null;
  const n = NAMES[code];
  const word = (v: string, what: string) => `${v} (${what}${n.money ? `, ${usd(BigInt(v))}` : ""})`;
  return `asked ${word(asked, n.asked)} against limit ${word(limit, n.limit)}`;
}

const str = (v: bigint | number | null): string | null => (v === null ? null : String(v));

/**
 * The verdict of checks 6 to 12 for `decision` in `state` (rules.ts's rankChecks), explained. Assumes, as
 * rankChecks does, that checks 1 to 5 passed. Throws if its own list of checks disagrees with rankChecks.
 */
export function explain(state: RoundState, decision: Decision): Explanation {
  const verdict = rankChecks(state, decision);
  if (decision.action === "SKIP") {
    if (verdict.verdict !== "SKIP") throw new Error(`explain: rankChecks gave ${verdict.verdict} for a skip`);
    return {
      verdict: "SKIP",
      code: null,
      check: null,
      asked: null,
      limit: null,
      notional_e6: null,
      long_shot: false,
      rule: "A skip that passes checks 1 to 5 is accepted and recorded. It is not a bet and uses none of the limits.",
      section: "01 §7",
      numbers: null,
      limit_from: null,
      steps: [],
    };
  }

  const each = alone(state, decision);
  let decided: Alone | undefined;
  const steps: Step[] = each.map((a) => {
    const reached = decided === undefined;
    if (reached && a.result === "fail") decided = a;
    return {
      check: checkNumber(a.code),
      code: a.code,
      outcome: reached ? a.result : "not reached",
      would: reached ? null : a.result,
      detail: a.detail,
      asked: a.result === "not applied" ? null : str(a.asked),
      limit: a.result === "not applied" ? null : str(a.limit),
    };
  });
  if (steps.map((s) => s.code).join() !== RANK_CODES.join())
    throw new Error("explain: the checks are not 6 to 12 in 01 §7's order");

  // The list must name the check that decided rankChecks' verdict, with the same numbers. The ticket is weighed
  // only once checks 6 to 8 pass (01 1.5 §7), so a bet refused before that was never judged as the ticket.
  const ticket = isTicket(state, decision) && (decided === undefined || checkNumber(decided.code) > 8);
  const notional = decision.margin_e6 * BigInt(decision.leverage);
  if (verdict.verdict === "YES") {
    if (decided !== undefined || verdict.notional_e6 !== notional)
      throw new Error(
        `explain disagrees with rules.ts: rankChecks says YES, this list ${decided?.code ?? "YES"}`,
      );
    return {
      verdict: "YES",
      code: null,
      check: null,
      asked: null,
      limit: null,
      notional_e6: notional.toString(),
      long_shot: ticket,
      rule: ticket
        ? "Checks 6 to 12 pass, with the bet judged as the round's long-shot ticket: one extra bet of a fixed size, " +
          "so checks 10 and 11 do not apply."
        : "Checks 6 to 12 all pass.",
      section: ticket ? "01 §7 (the long shot: 1.5, §9.7)" : "01 §7",
      numbers: `notional ${usd(notional)} (margin ${usd(decision.margin_e6)} × ${decision.leverage})`,
      limit_from: ticket
        ? `${ticketCapWords(state, decision)} ${dollarWords(state, "per_round")} ${baseWords(state)}`
        : `${dollarWords(state, "per_bet")} ${dollarWords(state, "per_round")} ${baseWords(state)}`,
      steps,
    };
  }
  if (verdict.verdict !== "NOPE") throw new Error(`explain: rankChecks gave ${verdict.verdict} for a bet`);
  if (
    decided === undefined ||
    decided.code !== verdict.code ||
    str(decided.asked) !== verdict.asked ||
    str(decided.limit) !== verdict.limit
  ) {
    throw new Error(
      `explain disagrees with rules.ts: rankChecks says ${verdict.code} ${verdict.asked}/${verdict.limit}, ` +
        `this list ${decided ? `${decided.code} ${str(decided.asked)}/${str(decided.limit)}` : "YES"}`,
    );
  }
  const code = decided.code;
  return {
    verdict: "NOPE",
    code,
    check: checkNumber(code),
    asked: verdict.asked,
    limit: verdict.limit,
    notional_e6: notional.toString(),
    long_shot: ticket,
    rule:
      code === "OVER_LEVERAGE" && ticket
        ? "A bet judged as the round's long-shot ticket may not go above the ticket's cap, lowered to what " +
          "Hyperliquid allows on that market."
        : RULES[code].rule,
    section: RULES[code].section,
    numbers: numbersOf(code, verdict.asked, verdict.limit),
    limit_from: limitFrom(state, decision, code),
    steps,
  };
}

/** The explanation as text lines, for a terminal or a tool result. */
export function explanationLines(e: Explanation): string[] {
  const head =
    e.verdict === "NOPE"
      ? `VERDICT of checks 6 to 12: NOPE ${e.code} (check ${e.check})`
      : `VERDICT of checks 6 to 12: ${e.verdict}${e.long_shot ? " (as the round's long-shot ticket)" : ""}`;
  const out = [head, `  rule:     ${e.rule} (${e.section})`];
  if (e.numbers !== null) out.push(`  numbers:  ${e.numbers}`);
  if (e.limit_from !== null) out.push(`  limits:   ${e.limit_from}`);
  if (e.steps.length > 0) out.push("  checks:");
  for (const s of e.steps) {
    const outcome = s.outcome === "not reached" ? `not reached (alone: ${s.would})` : s.outcome;
    out.push(`    ${String(s.check).padStart(2)} ${s.code.padEnd(18)} ${outcome.padEnd(32)} ${s.detail}`);
  }
  return out;
}
