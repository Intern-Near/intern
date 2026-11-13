import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Decision } from "../src/decision.ts";
import { checkNumber, type Explanation, explain, explanationLines, RULES, usd } from "../src/explain.ts";
import { MARKETS, type Market } from "../src/markets.ts";
import { dollarLimit, RANKS, type RankName, type Side } from "../src/ranks.ts";
import { longShotMarginE6 } from "../src/rulebook.ts";
import {
  limitBase,
  type Phase,
  REFUSAL_CODES,
  type RoundState,
  rankChecks,
  type Status,
} from "../src/rules.ts";
import { graph } from "./support/import-graph.ts";

// The explainer must give exactly rules.ts's verdict for checks 6 to 12 (rankChecks), and explain it with the
// numbers the deciding check compared. Engine 1's vectors first, then thousands of random states.

const CHECKS = JSON.parse(
  readFileSync(new URL("../../interface/vectors/checks.json", import.meta.url), "utf8"),
) as {
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
  decision_line_cases: {
    cases: {
      id: string;
      expected: {
        ok?:
          | { action: "SKIP" }
          | { action: "BET"; market: Market; side: Side; margin: string; leverage: number };
      };
    }[];
  };
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

function caseDecision(d: Case["decision"]): Decision {
  return d.action === "SKIP"
    ? { action: "SKIP" }
    : { action: "BET", market: d.market, side: d.side, margin_e6: BigInt(d.margin), leverage: d.leverage };
}

/** The explanation's verdict in rankChecks' terms, for comparing. */
function asVerdict(e: Explanation): unknown {
  if (e.verdict === "NOPE") return { verdict: "NOPE", code: e.code, asked: e.asked, limit: e.limit };
  if (e.verdict === "YES") return { verdict: "YES", notional_e6: BigInt(e.notional_e6 ?? "-1") };
  return { verdict: "SKIP" };
}

/** Checks 1 and 2 (the window, the firing) decide these; checks 6 to 12 never run, so a dry run cannot give them. */
const GATE_CODES = new Set(["OUTSIDE_WINDOW", "FIRED"]);
const applies = (c: Case) => !(c.expected.verdict === "NOPE" && GATE_CODES.has(c.expected.code));

describe("explain on Engine 1's vectors (interface/vectors/checks.json)", () => {
  it("applies to every rule case except 21, 22, 23 and 26, which checks 1 and 2 decide", () => {
    const not = CHECKS.rule_cases.filter((c) => !applies(c));
    assert.deepEqual(
      not.map((c) => [c.id, c.expected.verdict === "NOPE" ? c.expected.code : c.expected.verdict]),
      [
        [21, "FIRED"], // check 2: the Intern is fired
        [22, "OUTSIDE_WINDOW"], // check 1: phase OPEN, too early
        [23, "OUTSIDE_WINDOW"], // check 1 before check 2 (also FIRED), and a skip
        [26, "OUTSIDE_WINDOW"], // check 1: 1 ms after propose_until_ms
      ],
    );
    // Every other case is in the proposal window and employed, so checks 1 and 2 pass and 6 to 12 decide.
    for (const c of CHECKS.rule_cases.filter(applies)) {
      assert.equal(c.state.phase, "PROPOSE", `case ${c.id}`);
      assert.equal(c.state.status, "EMPLOYED", `case ${c.id}`);
    }
    assert.equal(CHECKS.rule_cases.filter(applies).length, 22);
  });

  for (const c of CHECKS.rule_cases.filter(applies)) {
    const want = c.expected;
    it(`case ${c.id}: ${want.verdict === "NOPE" ? `${want.code} ${want.asked}/${want.limit}` : want.verdict}`, () => {
      const e = explain(caseState(c), caseDecision(c.decision));
      assert.deepEqual(asVerdict(e), rankChecks(caseState(c), caseDecision(c.decision)));
      if (want.verdict === "NOPE") {
        assert.deepEqual([e.verdict, e.code, e.asked, e.limit], ["NOPE", want.code, want.asked, want.limit]);
        assert.equal(e.check, REFUSAL_CODES.indexOf(want.code as (typeof REFUSAL_CODES)[number]) + 1);
        assert.equal(e.rule, RULES[e.code as keyof typeof RULES].rule);
      } else {
        assert.equal(e.verdict, want.verdict);
        if (want.verdict === "YES") assert.equal(e.notional_e6, c.after.notional);
      }
    });
  }

  it("the cases decided by checks 1 and 2 still get rankChecks' own verdict for 6 to 12", () => {
    for (const c of CHECKS.rule_cases.filter((x) => !applies(x))) {
      const s = caseState(c);
      const d = caseDecision(c.decision);
      assert.deepEqual(asVerdict(explain(s, d)), rankChecks(s, d), `case ${c.id}`);
    }
  });

  it("the decision-line cases whose notes name a rank check: D10 is refused NOT_ON_LIST, D13 ZERO_MARGIN", () => {
    // decision_line_cases test check 5 (the shape), which a dry run does not run. Two notes say what the rank checks
    // do next: D10 (WIF) "the rank check refuses it later", D13 (margin "0") "the rank check then gives ZERO_MARGIN".
    // Under checks.json's assumptions (INTERN, $1,000 pool, no bets yet) that is NOT_ON_LIST and ZERO_MARGIN.
    const base = caseState(CHECKS.rule_cases[0] as Case);
    const read = (id: string) => {
      const ok = CHECKS.decision_line_cases.cases.find((x) => x.id === id)?.expected.ok;
      assert.ok(ok);
      return caseDecision(ok);
    };
    assert.equal(explain(base, read("D10")).code, "NOT_ON_LIST");
    assert.equal(explain(base, read("D13")).code, "ZERO_MARGIN");
    assert.equal(explain(base, read("D1")).verdict, "SKIP");
  });
});

describe("explain against rankChecks on random states", () => {
  // mulberry32, a fixed-seed 32-bit generator in integer arithmetic, so a failure can be reproduced. (The LCG of
  // test/rules.test.ts multiplies past 2^53 in floating point and degenerates: rnd(4) gives 0 in 99.6% of draws.)
  let seed = 20261113;
  const rnd = (n: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;
  const big = (n: number): bigint => BigInt(rnd(n));
  const ranks = Object.keys(RANKS) as RankName[];
  const markets = MARKETS.map((m) => m.market);

  function randomState(): RoundState {
    const rank = pick(ranks);
    // Pools from $0 to $5,000 with cents and micro-dollars; the pool now equal, lower or higher.
    const atOpen = big(5_000) * 1_000_000n + big(1_000_000);
    const now = pick([atOpen, atOpen, atOpen / 2n, atOpen - big(1_000), atOpen + big(100) * 1_000_000n, 0n]);
    const perRound = dollarLimit(
      limitBase({ brave_at_open_e6: atOpen, brave_now_e6: now }),
      RANKS[rank].per_round_bps,
    );
    const s: RoundState = {
      phase: pick(["OPEN", "PROPOSE", "HOLD", "CLOSE"] as const),
      status: pick(["EMPLOYED", "FIRED"] as const),
      rank,
      brave_at_open_e6: atOpen,
      brave_now_e6: now,
      bets_used: rnd(5),
      at_risk_e6: rnd(3) === 0 ? 0n : (perRound * big(150)) / 100n,
      ms_into_round: rnd(1_800_000),
      propose_from_ms: 900_000,
      propose_until_ms: 1_200_000,
    };
    if (rnd(4) === 0) s.min_notional_e6 = big(20) * 1_000_000n;
    if (rnd(3) === 0) {
      s.ticket = {
        margin_e6: rnd(4) === 0 ? big(50) * 1_000_000n : longShotMarginE6(atOpen),
        max_leverage: rnd(3) === 0 ? 3 + rnd(10) : 10,
      };
    }
    return s;
  }

  function randomDecision(s: RoundState): Decision {
    if (rnd(10) === 0) return { action: "SKIP" };
    const l = RANKS[s.rank];
    const perBet = dollarLimit(limitBase(s), l.per_bet_bps);
    const margin = pick([
      0n,
      s.ticket?.margin_e6 ?? 1n,
      s.ticket?.margin_e6 ?? 2n,
      perBet,
      perBet + 1n,
      perBet - 1n,
      big(200) * 1_000_000n + big(1_000_000),
      big(20) * 1_000_000n,
    ]);
    const leverage = pick([1, 1, 2, 3, 5, 10, 11, 1 + rnd(12)]);
    return {
      action: "BET",
      market: pick(markets),
      side: pick(["LONG", "SHORT"] as const),
      margin_e6: margin,
      leverage,
    };
  }

  it("gives rankChecks' verdict, code, asked and limit on 5,000 states, and covers every branch", () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 5_000; i++) {
      const s = randomState();
      const d = randomDecision(s);
      const v = rankChecks(s, d);
      const e = explain(s, d);
      const where = JSON.stringify({ s, d }, (_, x) => (typeof x === "bigint" ? x.toString() : x));
      assert.deepEqual(asVerdict(e), v, where);

      // The list of checks: 6 to 12 in order; before the deciding check all pass (or do not apply); after it, none
      // is reached; "not applied" only for 10 and 11, and only for the long-shot ticket.
      if (d.action === "BET") {
        assert.deepEqual(
          e.steps.map((x) => x.check),
          [6, 7, 8, 9, 10, 11, 12],
        );
        const firstFail = e.steps.findIndex((x) => x.outcome === "fail");
        assert.equal(e.steps.filter((x) => x.outcome === "fail").length, firstFail < 0 ? 0 : 1, where);
        if (firstFail >= 0) {
          assert.equal(e.steps[firstFail]?.code, e.code, where);
          assert.equal(e.steps[firstFail]?.check, e.check, where);
          assert.ok(
            e.steps.slice(firstFail + 1).every((x) => x.outcome === "not reached" && x.would !== null),
            where,
          );
        }
        // The ticket's shape (rankChecks' condition): its exact margin, above the rank's leverage.
        const shaped =
          s.ticket !== undefined &&
          d.margin_e6 === s.ticket.margin_e6 &&
          d.leverage > RANKS[s.rank].max_leverage;
        const notApplied = e.steps.filter((x) => x.outcome === "not applied" || x.would === "not applied");
        assert.deepEqual(
          notApplied.map((x) => x.check),
          shaped ? [10, 11] : [],
          where,
        );
        assert.equal(e.long_shot, shaped && (e.check === null || e.check > 8), where);
      } else {
        assert.deepEqual(e.steps, []);
      }
      const key =
        e.verdict === "NOPE"
          ? `${e.code}${e.long_shot ? " (ticket)" : ""}`
          : `${e.verdict}${e.long_shot ? " (ticket)" : ""}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // Every code of checks 6 to 12, YES, SKIP, and the ticket's three outcomes occur.
    for (const key of [
      ...REFUSAL_CODES.slice(5, 12),
      "YES",
      "SKIP",
      "YES (ticket)",
      "OVER_LEVERAGE (ticket)",
      "OVER_ROUND_LIMIT (ticket)",
    ]) {
      assert.ok(
        (seen.get(key) ?? 0) >= 10,
        `${key} occurred ${seen.get(key) ?? 0} times: ${JSON.stringify([...seen])}`,
      );
    }
  });
});

describe("what the explanation says", () => {
  const state = (over: Partial<RoundState> = {}): RoundState => ({
    phase: "PROPOSE",
    status: "EMPLOYED",
    rank: "INTERN",
    brave_at_open_e6: 1_000_000_000n,
    brave_now_e6: 1_000_000_000n,
    bets_used: 0,
    at_risk_e6: 0n,
    ms_into_round: 0,
    propose_from_ms: 0,
    propose_until_ms: 1,
    ...over,
  });
  const bet = (market: Market, side: Side, margin: bigint, leverage = 1): Decision => ({
    action: "BET",
    market,
    side,
    margin_e6: margin,
    leverage,
  });

  it("numbers the checks as 01 §7 does", () => {
    assert.deepEqual(
      (Object.keys(RULES) as (keyof typeof RULES)[]).map((c) => checkNumber(c)),
      [6, 7, 8, 9, 10, 11, 12],
    );
  });

  it("OVER_TRADE_LIMIT names the per-bet limit, its share and the limit base (case 25: half the pool left)", () => {
    const e = explain(state({ brave_now_e6: 500_000_000n }), bet("DOGE", "LONG", 20_000_000n));
    assert.equal(
      e.numbers,
      "asked 20000000 (the margin, $20.00) against limit 10000000 (the per-bet limit, $10.00)",
    );
    assert.equal(
      e.limit_from,
      "The per-bet limit $10.00 is 2% (INTERN's per_bet_bps 200, 01 §3) of the limit base, rounded down. The limit " +
        "base is $500.00: the smaller of the pool when the round opened ($1,000.00) and the pool now ($500.00), so a " +
        "limit is never sized on money that has left (01 §3, 1.1).",
    );
    assert.equal(e.section, "01 §7 check 11; the limit base is in §3 (1.1)");
    // Check 12 is not reached; alone it would fail too ($20 is above the per-round $10).
    assert.deepEqual(e.steps.at(-1)?.outcome, "not reached");
    assert.deepEqual(e.steps.at(-1)?.would, "fail");
  });

  it("the first failing check wins, and the others say what they would do alone (case 10)", () => {
    const e = explain(state(), bet("WIF", "SHORT", 900_000_000n, 5));
    assert.equal(e.code, "NOT_ON_LIST");
    assert.equal(e.numbers, null);
    assert.match(
      e.steps[0]?.detail ?? "",
      /WIF is not on INTERN's list \(DOGE, SHIB, PEPE, PENGU\); ranks that allow WIF: ANALYST, TRADER/,
    );
    assert.deepEqual(
      e.steps.map((s) => s.would),
      [null, "fail", "pass", "fail", "pass", "fail", "fail"],
    );
    assert.match(e.steps[1]?.detail ?? "", /ranks that allow short: TRADER/);
  });

  it("ZERO_MARGIN gives the notional against min_notional, from the state when the contract's is given", () => {
    const e = explain(state({ min_notional_e6: 12_000_000n }), bet("PEPE", "LONG", 11_500_000n));
    assert.deepEqual([e.code, e.asked, e.limit], ["ZERO_MARGIN", "11500000", "12000000"]);
    assert.equal(e.limit_from, "min_notional $12.00, the program's constant (01 §3, 1.2).");
  });

  it("the long-shot ticket: its cap is lowered to Hyperliquid's on PENGU; 10 and 11 do not apply", () => {
    const s = state({
      bets_used: 1,
      at_risk_e6: 15_000_000n,
      ticket: { margin_e6: 5_000_000n, max_leverage: 10 },
    });
    const pengu = explain(s, bet("PENGU", "LONG", 5_000_000n, 10));
    assert.deepEqual(
      [pengu.code, pengu.asked, pengu.limit, pengu.long_shot],
      ["OVER_LEVERAGE", "10", "5", true],
    );
    assert.match(pengu.limit_from ?? "", /the smaller of the ticket's 10x .* and Hyperliquid's 5x on PENGU/);
    const doge = explain(s, bet("DOGE", "LONG", 5_000_000n, 10));
    assert.deepEqual([doge.verdict, doge.long_shot, doge.notional_e6], ["YES", true, "50000000"]);
    assert.deepEqual(
      doge.steps.map((x) => x.outcome),
      ["pass", "pass", "pass", "pass", "not applied", "not applied", "pass"],
    );
    // Not the ticket's margin: an ordinary bet, refused at check 9 with the rank's own limit.
    const other = explain(s, bet("DOGE", "LONG", 6_000_000n, 10));
    assert.deepEqual([other.code, other.limit, other.long_shot], ["OVER_LEVERAGE", "1", false]);
    assert.match(other.steps[3]?.detail ?? "", /only a margin of exactly \$5.00 is judged as it/);
  });

  it("after a demotion the counters can be above the new rank's limits (rulebook case R3's state)", () => {
    const e = explain(
      state({ rank: "ANALYST", bets_used: 3, at_risk_e6: 200_000_000n }),
      bet("DOGE", "LONG", 11_000_000n),
    );
    assert.deepEqual([e.code, e.asked, e.limit], ["TOO_MANY_TRADES", "4", "2"]);
    assert.match(e.steps[4]?.detail ?? "", /after a demotion the count can be above the new rank's/);
  });

  it("writes dollars exactly", () => {
    assert.equal(usd(20_000_000n), "$20.00");
    assert.equal(usd(17_997_883n), "$17.997883");
    assert.equal(usd(1_572_985_657n), "$1,572.985657");
    assert.equal(usd(-72_416n), "-$0.072416");
    assert.equal(usd(0n), "$0.00");
  });

  it("as text: the verdict, the rule with its section, the numbers, where the limit comes from, each check", () => {
    const lines = explanationLines(explain(state(), bet("DOGE", "LONG", 20_000_001n)));
    assert.equal(lines[0], "VERDICT of checks 6 to 12: NOPE OVER_TRADE_LIMIT (check 11)");
    assert.match(lines[1] ?? "", /^ {2}rule: .*\(01 §7 check 11; the limit base is in §3 \(1\.1\)\)$/);
    assert.match(lines[2] ?? "", /asked 20000001 \(the margin, \$20.000001\) against limit 20000000/);
    assert.equal(lines.filter((l) => /^ {4}[ 1]\d [A-Z_]+ /.test(l)).length, 7);
  });
});

// ---------------------------------------------------------------- browser-safe

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

describe("the explainer and the quote are browser-safe", () => {
  it("explain.ts loads only rules.ts and ranks.ts: no node: import, no package, no Node global", () => {
    const g = graph(join(SRC, "explain.ts"));
    assert.deepEqual(g.outside, []);
    assert.deepEqual(g.files, ["explain.ts", "ranks.ts", "rules.ts"]);
    for (const f of g.files) {
      const src = readFileSync(join(SRC, f), "utf8");
      assert.doesNotMatch(src, /\b(process\.|require\(|__dirname|__filename|import\.meta|Buffer\b)/, f);
    }
  });

  it("quote.ts loads only relative modules; the one Node global among them is Buffer in buildRulebook, never called", () => {
    const g = graph(join(SRC, "quote.ts"));
    assert.deepEqual(g.outside, []);
    assert.deepEqual(g.files, [
      "contract.ts",
      "decision.ts",
      "explain.ts",
      "json.ts",
      "markets.ts",
      "pricing.ts",
      "quote.ts",
      "ranks.ts",
      "rulebook.ts",
      "rules.ts",
    ]);
    const globals = g.files.filter((f) =>
      /\b(process\.|require\(|__dirname|__filename|import\.meta|Buffer\b)/.test(
        readFileSync(join(SRC, f), "utf8"),
      ),
    );
    // rulebook.ts measures a playbook's bytes with Buffer inside buildRulebook; quote.ts uses only longShotOf and
    // longShotMarginE6 from it, which do not touch Buffer.
    assert.deepEqual(globals, ["rulebook.ts"]);
    assert.doesNotMatch(readFileSync(join(SRC, "quote.ts"), "utf8"), /buildRulebook/);
  });
});
