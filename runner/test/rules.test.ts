import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Decision } from "../src/decision.ts";
import type { Market } from "../src/markets.ts";
import { dollarLimit, MIN_NOTIONAL_E6, RANKS, type RankName, type Side } from "../src/ranks.ts";
import {
  checkDecision,
  type Phase,
  REFUSAL_CODES,
  type RoundState,
  type Status,
  type Verdict,
} from "../src/rules.ts";

// The 26 rule cases of 01-SHARED-INTERFACE.md §12 (version 1.2), read from Engine 1's
// intern/interface/vectors/checks.json. Checks 3 to 5 are assumed to pass; no funding quote is attached.

const bet = (market: Market, side: Side, margin_e6: bigint, leverage: number): Decision => ({
  action: "BET",
  market,
  side,
  margin_e6,
  leverage,
});
const SKIP: Decision = { action: "SKIP" };

const CHECKS = JSON.parse(
  readFileSync(new URL("../../interface/vectors/checks.json", import.meta.url), "utf8"),
) as {
  interface_version: string;
  min_notional: string;
  round: { propose_from_ms: number; propose_until_ms: number };
  rule_cases: {
    id: number;
    state: {
      rank: RankName;
      status: Status;
      phase: Phase;
      ms_into_round: number;
      brave_at_open: string;
      brave_now: string;
      bets_used: number;
      at_risk: string;
    };
    decision:
      | { action: "SKIP" }
      | { action: "BET"; market: Market; side: Side; margin: string; leverage: number };
    expected:
      | { verdict: "YES" | "SKIP" }
      | { verdict: "NOPE"; code: string; asked: string | null; limit: string | null };
    after: { bets_used: number; at_risk: string; notional?: string };
  }[];
};
type Case = (typeof CHECKS.rule_cases)[number];

function caseState(c: Case): RoundState {
  return {
    phase: c.state.phase,
    status: c.state.status,
    rank: c.state.rank,
    brave_at_open_e6: BigInt(c.state.brave_at_open),
    brave_now_e6: BigInt(c.state.brave_now),
    bets_used: c.state.bets_used,
    at_risk_e6: BigInt(c.state.at_risk),
    ms_into_round: c.state.ms_into_round,
    propose_from_ms: CHECKS.round.propose_from_ms,
    propose_until_ms: CHECKS.round.propose_until_ms,
  };
}

function caseDecision(c: Case): Decision {
  const d = c.decision;
  return d.action === "SKIP" ? SKIP : bet(d.market, d.side, BigInt(d.margin), d.leverage);
}

/** A default state for the cases below: $1,000 in the pool at the start and now, PROPOSE, EMPLOYED. */
function state(row: {
  rank: RankName;
  bets_used: number;
  at_risk: bigint;
  pool?: bigint;
  status?: Status;
  phase?: Phase;
}): RoundState {
  return {
    phase: row.phase ?? "PROPOSE",
    status: row.status ?? "EMPLOYED",
    rank: row.rank,
    brave_at_open_e6: row.pool ?? 1_000_000_000n,
    brave_now_e6: row.pool ?? 1_000_000_000n,
    bets_used: row.bets_used,
    at_risk_e6: row.at_risk,
    ms_into_round: 0,
    propose_from_ms: 900_000,
    propose_until_ms: 1_200_000,
  };
}

function show(v: Verdict): string {
  if (v.verdict !== "NOPE") return v.verdict;
  return v.asked === null ? v.code : `${v.code} ${v.asked}/${v.limit}`;
}

describe("rank checks, the 26 rule cases of checks.json (01 1.2 §12)", () => {
  it("reads version 1.2 with the $11 minimum and all 26 cases", () => {
    assert.equal(CHECKS.interface_version, "1.4");
    assert.equal(BigInt(CHECKS.min_notional), MIN_NOTIONAL_E6);
    assert.deepEqual(
      CHECKS.rule_cases.map((c) => c.id),
      Array.from({ length: 26 }, (_, i) => i + 1),
    );
  });

  for (const c of CHECKS.rule_cases) {
    const want = c.expected;
    it(`case ${c.id}: ${want.verdict === "NOPE" ? `${want.code} ${want.asked}/${want.limit}` : want.verdict}`, () => {
      const got = checkDecision(caseState(c), caseDecision(c));
      if (want.verdict === "NOPE") {
        assert.deepEqual(got, { verdict: "NOPE", code: want.code, asked: want.asked, limit: want.limit });
      } else {
        assert.equal(got.verdict, want.verdict);
      }
      // `after`: a YES adds one bet and its margin, and carries the notional; SKIP and NOPE change nothing.
      const s = caseState(c);
      if (got.verdict === "YES") {
        const d = caseDecision(c);
        assert.ok(d.action === "BET");
        assert.equal(s.bets_used + 1, c.after.bets_used);
        assert.equal(s.at_risk_e6 + d.margin_e6, BigInt(c.after.at_risk));
        assert.equal(got.notional_e6, BigInt(c.after.notional ?? "-1"));
      } else {
        assert.equal(s.bets_used, c.after.bets_used);
        assert.equal(s.at_risk_e6, BigInt(c.after.at_risk));
      }
    });
  }
});

describe("rank checks, first failure wins", () => {
  // An independent list of 01 §7's conditions, in order. The verdict must be the first that holds.
  function failing(s: RoundState, d: Decision): string[] {
    const out: string[] = [];
    if (s.phase !== "PROPOSE") out.push("OUTSIDE_WINDOW");
    if (s.status === "FIRED") out.push("FIRED");
    if (d.action === "SKIP") return out;
    const l = RANKS[s.rank];
    if (!l.markets.includes(d.market)) out.push("NOT_ON_LIST");
    if (d.side === "SHORT" && !l.sides.includes("SHORT")) out.push("SHORT_NOT_UNLOCKED");
    if (d.margin_e6 === 0n || d.margin_e6 * BigInt(d.leverage) < MIN_NOTIONAL_E6) out.push("ZERO_MARGIN");
    if (d.leverage > l.max_leverage) out.push("OVER_LEVERAGE");
    if (s.bets_used >= l.max_bets) out.push("TOO_MANY_TRADES");
    // biome-ignore lint/complexity/useMathMinMax: these are bigints, and Math.min throws on bigint.
    const base = s.brave_now_e6 < s.brave_at_open_e6 ? s.brave_now_e6 : s.brave_at_open_e6;
    if (d.margin_e6 > dollarLimit(base, l.per_bet_bps)) out.push("OVER_TRADE_LIMIT");
    if (s.at_risk_e6 + d.margin_e6 > dollarLimit(base, l.per_round_bps)) out.push("OVER_ROUND_LIMIT");
    return out;
  }

  it("on 20,000 random proposals", () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
    const markets: Market[] = ["DOGE", "SHIB", "PEPE", "PENGU", "WIF", "TRUMP"];
    for (let i = 0; i < 20_000; i++) {
      const s: RoundState = {
        phase: pick(["OPEN", "PROPOSE", "PROPOSE", "PROPOSE", "HOLD", "CLOSE"] as const),
        status: pick(["EMPLOYED", "EMPLOYED", "EMPLOYED", "FIRED"] as const),
        rank: pick(["INTERN", "ANALYST", "TRADER"] as const),
        brave_at_open_e6: BigInt(rnd(5_000)) * 1_000_000n,
        brave_now_e6: BigInt(rnd(5_000)) * 1_000_000n,
        bets_used: rnd(5),
        at_risk_e6: BigInt(rnd(300)) * 1_000_000n,
        ms_into_round: rnd(1_800_000),
        propose_from_ms: 900_000,
        propose_until_ms: 1_200_000,
      };
      const d: Decision =
        rnd(8) === 0
          ? SKIP
          : bet(pick(markets), pick(["LONG", "SHORT"] as const), BigInt(rnd(150)) * 1_000_000n, 1 + rnd(4));
      const v = checkDecision(s, d);
      const first = failing(s, d)[0];
      if (first === undefined) {
        assert.equal(
          v.verdict,
          d.action === "SKIP" ? "SKIP" : "YES",
          JSON.stringify({ s, d }, (_, x) => String(x)),
        );
      } else {
        assert.ok(v.verdict === "NOPE" && v.code === first, `${first} expected, got ${show(v)}`);
      }
    }
  });

  it("lists the sixteen codes in 01 §7's order", () => {
    assert.equal(REFUSAL_CODES.length, 16);
    assert.equal(REFUSAL_CODES[0], "OUTSIDE_WINDOW");
    assert.equal(REFUSAL_CODES[7], "ZERO_MARGIN");
    assert.equal(REFUSAL_CODES[15], "TOO_EXPENSIVE");
  });
});

describe("rank checks, cases proposed beyond 01 §12", () => {
  // The decision line allows any margin that fits in u128 and any leverage that fits in u32. In Rust,
  // margin × leverage at check 8 can overflow u128; a panic would abort the transaction and erase the refusal,
  // which 01 §7 forbids. Raised with the owner as a 25th case for checks.json.
  const U128_MAX = (1n << 128n) - 1n;

  it("the largest margin at 2x is refused as OVER_TRADE_LIMIT, not by an overflow", () => {
    const v = checkDecision(
      state({ rank: "TRADER", bets_used: 0, at_risk: 0n }),
      bet("DOGE", "LONG", U128_MAX, 2),
    );
    assert.equal(show(v), `OVER_TRADE_LIMIT ${U128_MAX}/100000000`);
  });

  it("the largest leverage is refused as OVER_LEVERAGE", () => {
    const v = checkDecision(
      state({ rank: "TRADER", bets_used: 0, at_risk: 0n }),
      bet("DOGE", "LONG", 50_000_000n, 4_294_967_295),
    );
    assert.equal(show(v), "OVER_LEVERAGE 4294967295/2");
  });
});
