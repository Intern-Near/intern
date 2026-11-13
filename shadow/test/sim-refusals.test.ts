import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Decision } from "../../runner/src/decision.ts";
import { MARKETS, type Market } from "../../runner/src/markets.ts";
import type { RankName, Side } from "../../runner/src/ranks.ts";
import { checkDecision, type RoundState, type Status, type Verdict } from "../../runner/src/rules.ts";
import { type Answer, judgeWithLimits, runSim } from "../src/sim/engine.ts";
import { Rng } from "../src/sim/rng.ts";
import { PRODUCT_CLOCK } from "../src/sim/rules01.ts";
import { SCENARIOS } from "../src/sim/scenarios.ts";
import { newWorld, type SimRound } from "../src/sim/world.ts";
import { config, flatMoves } from "./sim-fixtures.ts";

// The simulation must refuse exactly what runner/src/rules.ts refuses. Three checks: Engine 1's 26 rule cases of
// 01 §12 put through the sim's own judging path; random states and bets compared with rules.ts on a RoundState built
// independently here; and every proposal of real sim runs re-judged with rules.ts.

const CHECKS = JSON.parse(
  readFileSync(new URL("../../interface/vectors/checks.json", import.meta.url), "utf8"),
) as {
  rule_cases: {
    id: number;
    state: {
      rank: RankName;
      status: Status;
      phase: string;
      brave_at_open: string;
      brave_now: string;
      bets_used: number;
      at_risk: string;
    };
    decision:
      | { action: "SKIP" }
      | { action: "BET"; market: Market; side: Side; margin: string; leverage: number };
    expected: { verdict: string; code?: string; asked?: string | null; limit?: string | null };
  }[];
};

interface Raw {
  rank: RankName;
  status: Status;
  open: bigint;
  now: bigint;
  bets_used: number;
  at_risk: bigint;
}

/** The sim's own world and round for a raw state, and its judging path. */
function simJudge(raw: Raw, answer: Answer): string {
  const w = newWorld();
  w.rank = raw.rank;
  w.status = raw.status;
  w.pot.brave_total = raw.now;
  const round: SimRound = {
    id: 1,
    brave_at_open: raw.open,
    bets_used: raw.bets_used,
    at_risk: raw.at_risk,
    playbook_active: false,
    positions: [],
    limit_bps: 0,
  };
  return judgeWithLimits(w, PRODUCT_CLOCK, round, answer).key;
}

/** runner/src/rules.ts on a RoundState built here, independently of the sim. */
function rulesJudge(raw: Raw, decision: Decision): Verdict {
  const state: RoundState = {
    phase: "PROPOSE",
    status: raw.status,
    rank: raw.rank,
    brave_at_open_e6: raw.open,
    brave_now_e6: raw.now,
    bets_used: raw.bets_used,
    at_risk_e6: raw.at_risk,
    ms_into_round: PRODUCT_CLOCK.propose_from_ms,
    propose_from_ms: PRODUCT_CLOCK.propose_from_ms,
    propose_until_ms: PRODUCT_CLOCK.propose_until_ms,
  };
  return checkDecision(state, decision);
}

const keyOf = (v: Verdict): string => (v.verdict === "NOPE" ? v.code : v.verdict);

describe("the sim refuses exactly what runner/src/rules.ts refuses", () => {
  it("Engine 1's rule cases of 01 §12 (those inside the proposal window, where the runner asks)", () => {
    let checked = 0;
    for (const c of CHECKS.rule_cases) {
      // Cases 22, 23 and 26 are outside the window; the runner never asks there, so the sim cannot reach them.
      if (c.state.phase !== "PROPOSE") continue;
      const raw: Raw = {
        rank: c.state.rank,
        status: c.state.status,
        open: BigInt(c.state.brave_at_open),
        now: BigInt(c.state.brave_now),
        bets_used: c.state.bets_used,
        at_risk: BigInt(c.state.at_risk),
      };
      const decision: Decision =
        c.decision.action === "SKIP"
          ? { action: "SKIP" }
          : {
              action: "BET",
              market: c.decision.market,
              side: c.decision.side,
              margin_e6: BigInt(c.decision.margin),
              leverage: c.decision.leverage,
            };
      const answer: Answer = decision.action === "SKIP" ? { kind: "skip" } : { kind: "bet", decision };
      const expected = c.expected.verdict === "NOPE" ? c.expected.code : c.expected.verdict;
      assert.equal(simJudge(raw, answer), expected, `case ${c.id}`);
      const v = rulesJudge(raw, decision);
      assert.equal(keyOf(v), expected, `case ${c.id}, rules.ts`);
      if (v.verdict === "NOPE") {
        assert.equal(v.asked, c.expected.asked ?? null, `case ${c.id} asked`);
        assert.equal(v.limit, c.expected.limit ?? null, `case ${c.id} limit`);
      }
      checked += 1;
    }
    assert.equal(checked, 23);
  });

  it("random states and bets: the same verdict as rules.ts every time", () => {
    const rng = new Rng(2026);
    const ranks: RankName[] = ["INTERN", "ANALYST", "TRADER"];
    const markets = MARKETS.map((m) => m.market);
    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i++) {
      const open = BigInt(rng.int(5_000_000_000));
      const now = rng.chance(0.5) ? open : (open * BigInt(rng.int(1_000))) / 1_000n;
      const raw: Raw = {
        rank: rng.pick(ranks),
        status: rng.chance(0.1) ? "FIRED" : "EMPLOYED",
        open,
        now,
        bets_used: rng.int(4),
        at_risk: (open * BigInt(rng.int(2_500))) / 10_000n,
      };
      if (rng.chance(0.1)) {
        assert.equal(simJudge(raw, { kind: "skip" }), keyOf(rulesJudge(raw, { action: "SKIP" })));
        assert.equal(
          simJudge(raw, { kind: "unreadable", code: "MALFORMED_DECISION" }),
          raw.status === "FIRED" ? "FIRED" : "MALFORMED_DECISION",
        );
        continue;
      }
      const decision: Decision = {
        action: "BET",
        market: rng.pick(markets),
        side: rng.chance(0.7) ? "LONG" : "SHORT",
        margin_e6: (open * BigInt(rng.int(1_200))) / 10_000n + BigInt(rng.int(3)),
        leverage: 1 + rng.int(3),
      };
      const sim = simJudge(raw, { kind: "bet", decision });
      const rules = keyOf(rulesJudge(raw, decision));
      assert.equal(sim, rules, `case ${i}`);
      seen.add(rules);
    }
    for (const code of [
      "YES",
      "FIRED",
      "NOT_ON_LIST",
      "SHORT_NOT_UNLOCKED",
      "ZERO_MARGIN",
      "OVER_LEVERAGE",
    ]) {
      assert.ok(seen.has(code), `the random cases reached ${code}`);
    }
    for (const code of ["TOO_MANY_TRADES", "OVER_TRADE_LIMIT", "OVER_ROUND_LIMIT"]) {
      assert.ok(seen.has(code), `the random cases reached ${code}`);
    }
  });

  it("every proposal of real runs: rules.ts gives the recorded verdict, and only YES becomes a bet", () => {
    for (const s of SCENARIOS.filter((x) => ["baseline", "always-max", "brave-run"].includes(x.name))) {
      const cfg = config({
        rounds: 30,
        audit: true,
        intern: s.intern === "max" ? { kind: "max" } : config().intern,
        asks: s.asks === "until-full" ? "until-full" : 1,
        run: s.run ? { ...s.run, day: 10 } : null,
        moves: flatMoves(30, 1_030_000, 960_000, 1_050_000),
      });
      const w = runSim(cfg);
      const audit = w.audit ?? [];
      assert.ok(audit.length > 0);
      const counts: Record<string, number> = {};
      for (const e of audit) {
        const key = e.decision === null ? (e.unreadable ?? "?") : keyOf(checkDecision(e.state, e.decision));
        if (e.decision !== null) assert.deepEqual(checkDecision(e.state, e.decision), e.verdict);
        assert.equal(e.state.phase, "PROPOSE");
        assert.equal(e.state.status, "EMPLOYED", "the runner asks nothing while the Intern is fired");
        counts[key] = (counts[key] ?? 0) + 1;
      }
      assert.deepEqual(counts, w.counters.verdicts, s.name);
      assert.equal(w.counters.placed, counts.YES ?? 0, `${s.name}: only YES becomes a bet`);
      assert.equal(w.counters.approved_over_limit, 0);
    }
  });
});
