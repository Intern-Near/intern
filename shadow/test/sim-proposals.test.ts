import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Recorded } from "../src/sim/behaviour.ts";
import { heldForRewards, jackpotEligible } from "../src/sim/community.ts";
import { runSim } from "../src/sim/engine.ts";
import { coinPriceE6, payIn } from "../src/sim/ledger.ts";
import { anyOn, PROPOSALS, proposalsFrom, TODAY } from "../src/sim/proposals.ts";
import { enterDraw, holdDraw, newRewards } from "../src/sim/rewards.ts";
import { Rng } from "../src/sim/rng.ts";
import { REWARDS } from "../src/sim/rules01.ts";
import { addAccount, newWorld } from "../src/sim/world.ts";
import { config, flatMoves, SMALL_COMMUNITY } from "./sim-fixtures.ts";

// Each PROPOSAL (src/sim/proposals.ts) does what it says, and nothing when it is off.

const MAX_BET: Recorded[] = [
  { kind: "bet", market: "DOGE", side: "LONG", leverage: 1, size: { kind: "max" }, ms: 20_000 },
];
const NO_VOTES = { ...SMALL_COMMUNITY, lock_share: 0, votes: false, playbook_day: null, tips_per_day_usd: 0 };

describe("the proposals catalogue", () => {
  it("is off by default and switched on by name or letter", () => {
    assert.equal(anyOn(TODAY), false);
    assert.deepEqual(proposalsFrom(["a"]).three_strikes, { strikes: 3 });
    assert.equal(proposalsFrom(["dollar-draw"]).dollar_draw, true);
    assert.equal(proposalsFrom(["farm-fixes"]).lowest_balance, true);
    assert.throws(() => proposalsFrom(["nope"]), /no proposal/);
    for (const p of PROPOSALS) assert.ok(anyOn(proposalsFrom([p.name])), p.name);
  });

  it("today's rules give the same run with or without the proposals module", () => {
    const a = runSim(config({ seed: 3 }));
    const b = runSim(config({ seed: 3, proposals: TODAY }));
    assert.equal(coinPriceE6(a.pot), coinPriceE6(b.pot));
    assert.deepEqual(a.counters.verdicts, b.counters.verdicts);
  });
});

describe("a. three strikes", () => {
  it("suspends the Intern after three refusals in a row; skips are never strikes", () => {
    const broken: Recorded[] = [{ kind: "unreadable", code: "MALFORMED_DECISION" }];
    const w = runSim(
      config({
        rounds: 10,
        intern: { kind: "recorded", decisions: broken },
        community: NO_VOTES,
        proposals: proposalsFrom(["a"]),
      }),
    );
    assert.equal(w.pc.suspensions, 1);
    assert.equal(w.status, "FIRED");
    assert.equal(w.counters.asked, 3, "suspended at the third refusal; nobody rehires");
    assert.deepEqual(
      w.counters.rank_changes.map((c) => c.by),
      ["THREE_STRIKES"],
    );
    // Nothing but skips: never a strike.
    const skips: Recorded[] = [{ kind: "skip" }];
    const v = runSim(
      config({
        rounds: 10,
        intern: { kind: "recorded", decisions: skips },
        community: NO_VOTES,
        proposals: proposalsFrom(["a"]),
      }),
    );
    assert.equal(v.pc.suspensions, 0);
  });

  it("while suspended, the bets today's rules would have taken count as blocked", () => {
    // Mostly malformed answers, now and then a bet of the example size that today's rules approve.
    const decisions: Recorded[] = [
      { kind: "unreadable", code: "MALFORMED_DECISION" },
      { kind: "unreadable", code: "MALFORMED_DECISION" },
      { kind: "unreadable", code: "MALFORMED_DECISION" },
      { kind: "bet", market: "DOGE", side: "LONG", leverage: 1, size: { kind: "example" } },
    ];
    const w = runSim(
      config({
        rounds: 40,
        intern: { kind: "recorded", decisions },
        community: NO_VOTES,
        proposals: proposalsFrom(["a"]),
      }),
    );
    assert.equal(w.pc.suspensions, 1, "nobody rehires");
    const fired = w.counters.rounds_in.FIRED ?? 0;
    assert.ok(w.pc.blocked > 0 && w.pc.blocked <= fired, `${w.pc.blocked} blocked in ${fired} rounds fired`);
  });

  it("a rehire vote brings it back at INTERN", () => {
    const broken: Recorded[] = [{ kind: "unreadable", code: "MALFORMED_DECISION" }];
    const w = runSim(
      config({
        rounds: 30,
        intern: { kind: "recorded", decisions: broken },
        community: { ...SMALL_COMMUNITY, lock_share: 1, turnout: 1, yes_rehire: 1, rehire_after_days: 3 },
        proposals: proposalsFrom(["a"]),
      }),
    );
    assert.ok(w.pc.suspensions >= 2, "suspended, rehired, suspended again");
    assert.ok(w.counters.rank_changes.some((c) => c.by === "REHIRE"));
  });
});

describe("b. the drawdown halt", () => {
  // Every bet loses half its notional: at INTERN the pool loses about 1% a round.
  const falling = flatMoves(40, 500_000, 500_000, 1_000_000);

  it("stops new bets once the coin is 10% below its high; nobody voting, it never lifts", () => {
    const w = runSim(
      config({
        rounds: 40,
        intern: { kind: "max" },
        moves: falling,
        community: NO_VOTES,
        proposals: proposalsFrom(["b"]),
      }),
    );
    assert.equal(w.pc.halts, 1);
    assert.ok(w.ps.halted);
    const haltedAt = w.ps.halted_round ?? 0;
    assert.equal(w.counters.asked, haltedAt, "one ask a round until the halt, none after");
    assert.equal(w.pc.rounds_halted, 40 - haltedAt);
    // Each halted round blocks the bet today's rules would take (unless an honest cash-out made today refuse it too).
    assert.ok(w.pc.blocked > 0 && w.pc.blocked <= 40 - haltedAt);
    assert.deepEqual(w.counters.invariant_failures, [], "the bet open when it tripped still settled");
    const today = runSim(
      config({ rounds: 40, intern: { kind: "max" }, moves: falling, community: NO_VOTES }),
    );
    assert.ok(coinPriceE6(w.pot) > coinPriceE6(today.pot));
  });

  it("a RESUME vote lifts it", () => {
    const w = runSim(
      config({
        rounds: 40,
        intern: { kind: "max" },
        moves: falling,
        // Bosses resume after two days; their own firing trigger is switched off (a 100% fall) to keep the test to the halt.
        community: {
          ...NO_VOTES,
          lock_share: 1,
          votes: true,
          turnout: 1,
          yes_rehire: 1,
          fire_drawdown_bps: 10_000,
          rehire_after_days: 2,
        },
        proposals: proposalsFrom(["b"]),
      }),
    );
    assert.ok(w.votes.some((v) => v.kind === "RESUME" && v.state === "PASSED"));
    assert.ok(w.pc.halts >= 2, "resumed, then halted again as the losses went on");
  });
});

describe("c. the record gate", () => {
  it("halves the limits after a poor week, so the losses shrink", () => {
    const falling = flatMoves(20, 700_000, 700_000, 1_000_000);
    const base = { rounds: 20, intern: { kind: "max" } as const, moves: falling, community: NO_VOTES };
    const today = runSim(config(base));
    const w = runSim(config({ ...base, proposals: proposalsFrom(["c"]) }));
    assert.ok(w.pc.rounds_gated > 0);
    assert.ok(w.pc.shrunk > 0);
    assert.ok(w.counters.bets_result > today.counters.bets_result, "smaller bets lost less");
  });
});

describe("d. the buy-and-burn", () => {
  it("shrinks the supply and pays holders, but leaves the coin price where it was", () => {
    const rising = flatMoves(20, 1_050_000);
    const base = { rounds: 20, intern: { kind: "max" } as const, moves: rising, community: NO_VOTES };
    const today = runSim(config(base));
    const w = runSim(config({ ...base, proposals: proposalsFrom(["d"]) }));
    assert.ok(w.pc.burn_spent > 0n);
    assert.ok(w.pot.supply < today.pot.supply);
    const a = Number(coinPriceE6(w.pot));
    const b = Number(coinPriceE6(today.pot));
    assert.ok(Math.abs(a - b) / b < 1e-4, `${a} vs ${b}`);
    assert.deepEqual(w.counters.invariant_failures, []);
  });
});

describe("e. the rulebook's max on the pool now", () => {
  const before = { usd: 0.01, at: "before" as const };
  const inFlight = { usd: 0.01, at: "in-flight" as const };
  const base = { rounds: 15, intern: { kind: "recorded" as const, decisions: MAX_BET }, community: NO_VOTES };

  it("today a cent cashed out before the window refuses every max-size bet; with e1 none is", () => {
    const today = runSim(config({ ...base, griefer: before }));
    assert.equal(today.counters.refused_money_left, 15);
    const e1 = runSim(config({ ...base, griefer: before, proposals: proposalsFrom(["e1"]) }));
    assert.equal(e1.counters.refused_money_left, 0);
    assert.equal(e1.pc.unblocked, 15);
  });

  it("a cent cashed out while the model answers: today OVER_TRADE_LIMIT; e1 WRONG_RULEBOOK; e2 asks again", () => {
    const today = runSim(config({ ...base, griefer: inFlight }));
    assert.equal(today.counters.verdicts.OVER_TRADE_LIMIT, 15);
    const e1 = runSim(config({ ...base, griefer: inFlight, proposals: proposalsFrom(["e1"]) }));
    assert.equal(e1.counters.verdicts.WRONG_RULEBOOK, 15);
    const e2 = runSim(config({ ...base, griefer: inFlight, proposals: proposalsFrom(["e2"]) }));
    assert.equal(e2.counters.verdicts.WRONG_RULEBOOK ?? 0, 0);
    assert.equal(e2.pc.reasks, 15);
    assert.equal(e2.counters.verdicts.YES, 15);
  });
});

describe("f. the farming fixes", () => {
  it("f1: tickets count the lowest balance of the period", () => {
    const rw = newRewards();
    enterDraw(rw, "a", 100n, 1);
    enterDraw(rw, "b", 100n, 1);
    rw.draw_pot = 1_000n;
    const d = holdDraw(rw, 8, () => 100n, new Rng(1), { lowest: (id) => (id === "a" ? 10n : undefined) });
    assert.equal(d?.tickets_total, 10n * 7n + 100n * 7n);
  });

  it("f1 and f2: the jackpot's $10 must have been held, not just arrived", () => {
    const w = newWorld(false, proposalsFrom(["f1"]));
    const a = addAccount(w, "boss");
    a.joined_round = 1;
    a.safe = 20_000_000n;
    w.pot.safe_total = a.safe;
    w.round = 9;
    w.ps.balances.set(a.id, [20_000_000n, 2_000_000n, 20_000_000n]);
    assert.equal(jackpotEligible(w, a), false, "it dipped to $2 within the last 7 rounds");
    w.ps.balances.set(a.id, [20_000_000n]);
    assert.equal(jackpotEligible(w, a), true);
    const v = newWorld(false, proposalsFrom(["f2"]));
    const b = addAccount(v, "boss");
    b.joined_round = 1;
    v.round = 9;
    v.ps.at_open.set(b.id, 0n);
    payIn(v.pot, b, "SAFE", 20_000_000n);
    assert.equal(heldForRewards(v, b), 0n, "paid in this round: counts from the next opening");
    assert.equal(jackpotEligible(v, b), false);
  });

  it("f3: a full draw takes a bigger newcomer in place of the smallest; prizes are drawn with replacement", () => {
    const rw = newRewards();
    const size = (id: string): bigint => (id.startsWith("fake") ? 10n : 1_000n);
    for (let i = 0; i < REWARDS.max_entrants; i++) enterDraw(rw, `fake${i}`, 10n, 1, size);
    assert.equal(enterDraw(rw, "small", 5n, 1, size), "FULL");
    assert.equal(enterDraw(rw, "big", 1_000n, 1, size), "IN");
    assert.equal(rw.bumped.length, 1);
    // Two entrants, 9 to 1 in tickets: over many draws the big one takes about 90% of the prizes.
    let big = 0n;
    let all = 0n;
    for (let s = 0; s < 400; s++) {
      const r = newRewards();
      enterDraw(r, "big", 900n, 1);
      enterDraw(r, "small", 100n, 1);
      r.draw_pot = 1_000_000n;
      holdDraw(r, 8, (id) => (id === "big" ? 900n : 100n), new Rng(s), { withReplacement: true });
      big += r.prizes.draw.get("big") ?? 0n;
      all += (r.prizes.draw.get("big") ?? 0n) + (r.prizes.draw.get("small") ?? 0n);
    }
    const share = Number((big * 1000n) / all) / 10;
    assert.ok(share > 85 && share < 95, `${share}%`);
  });

  it("f3 in a run: fake accounts no longer take the whole draw", () => {
    // 200 fakes fill the draw's places before the first honest boss arrives.
    const fakes = { count: 200, brave_usd: 0.01, safe_usd: 10 };
    const base = {
      rounds: 30,
      fakes,
      community: { ...SMALL_COMMUNITY, start_bosses: 20, draw_join_share: 1 },
    };
    const share = (proposals?: string): number => {
      const w = runSim(config({ ...base, ...(proposals ? { proposals: proposalsFrom([proposals]) } : {}) }));
      let fake = 0n;
      let all = 0n;
      for (const [id, x] of w.rewards.prizes.draw) {
        all += x;
        if (id.startsWith("fake")) fake += x;
      }
      return all === 0n ? 0 : Number((fake * 1000n) / all) / 10;
    };
    assert.ok(share("f3") < share(), "dollar-weighted draw cuts the fakes' share");
  });
});
