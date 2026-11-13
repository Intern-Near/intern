import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { positionResult, runSim } from "../src/sim/engine.ts";
import { coinPriceE6 } from "../src/sim/ledger.ts";
import { resultOf } from "../src/sim/metrics.ts";
import { moveTable, windowStarts } from "../src/sim/prices.ts";
import { clockFor } from "../src/sim/rules01.ts";
import { SCENARIOS } from "../src/sim/scenarios.ts";
import { config, flatMoves, prices, SMALL_COMMUNITY } from "./sim-fixtures.ts";

const meta = { scenario: "t", arm: "limits" as const, seed: 7, window_start: "-", rounds: 20 };

describe("one bet at the close", () => {
  const p = { market: "DOGE" as const, side: "LONG" as const, margin: 100_000_000n, leverage: 2 };
  it("margin plus the move on the notional, less the round-trip cost", () => {
    const up = positionResult(p, { exit_ppm: 1_050_000, low_ppm: 990_000, high_ppm: 1_060_000 }, 17, false);
    // 200 notional: +10 from the move, -0.34 cost.
    assert.equal(up.returned, 100_000_000n + 10_000_000n - 340_000n);
    const short = positionResult(
      { ...p, side: "SHORT" },
      { exit_ppm: 1_050_000, low_ppm: 990_000, high_ppm: 1_060_000 },
      17,
      false,
    );
    assert.equal(short.returned, 100_000_000n - 10_000_000n - 340_000n);
  });
  it("loses the whole margin when the worst price reached it (2x: a 50% fall)", () => {
    assert.equal(
      positionResult(p, { exit_ppm: 1_000_000, low_ppm: 500_000, high_ppm: 1_000_000 }, 17, false).liquidated,
      true,
    );
    assert.equal(
      positionResult(p, { exit_ppm: 1_000_000, low_ppm: 500_001, high_ppm: 1_000_000 }, 17, false).liquidated,
      false,
    );
  });
  it("in a losing round the bet is on the side that lost; with no price it closes flat and pays the cost", () => {
    const lost = positionResult(p, { exit_ppm: 1_050_000, low_ppm: 990_000, high_ppm: 1_060_000 }, 0, true);
    assert.equal(lost.returned, 90_000_000n);
    assert.equal(positionResult(p, null, 17, false).returned, 100_000_000n - 340_000n);
  });
});

describe("runs", () => {
  it("are deterministic: the same seed gives the same run, another seed another", () => {
    const a = JSON.stringify(resultOf(runSim(config()), meta));
    const b = JSON.stringify(resultOf(runSim(config()), meta));
    const c = JSON.stringify(resultOf(runSim(config({ seed: 8 })), meta));
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("an Intern that always bets the most may lose at most its rank's per-round limit; without the limits, more", () => {
    const down = flatMoves(25, 900_000, 850_000, 1_000_000);
    const limited = runSim(config({ rounds: 25, intern: { kind: "max" }, asks: "until-full", moves: down }));
    assert.ok(limited.counters.worst_loss_vs_limit <= 1);
    assert.ok(limited.counters.placed > 0);
    const control = runSim(config({ rounds: 25, intern: { kind: "max" }, arm: "control", moves: down }));
    assert.ok(
      control.counters.worst_loss_vs_limit > 1,
      "without the limits a round can lose more than the rank allows",
    );
    assert.ok(control.counters.liquidated > 0, "10x on a 15% fall");
    assert.ok(coinPriceE6(control.pot) < coinPriceE6(limited.pot));
  });

  it("in a losing streak no bet wins", () => {
    const w = runSim(
      config({ rounds: 15, losing: { from_round: 1, to_round: 15 }, moves: flatMoves(15, 1_020_000) }),
    );
    assert.ok(w.counters.placed > 0);
    assert.equal(w.counters.won, 0);
  });

  it("the runner asks nothing while the Intern is fired", () => {
    const fall = flatMoves(30, 600_000, 500_000, 1_000_000);
    const w = runSim(
      config({
        rounds: 30,
        intern: { kind: "max" },
        arm: "control",
        moves: fall,
        community: { ...SMALL_COMMUNITY, lock_share: 1, turnout: 1, yes_tighten: 1, rehire_after_days: 100 },
      }),
    );
    assert.ok(w.counters.rank_changes.some((c) => c.to === "FIRED"));
    const fired = w.counters.rounds_in.FIRED ?? 0;
    assert.ok(fired > 0);
    // Firing votes are cast before the proposal, so a round that ends FIRED had no proposal: one ask per other round.
    assert.equal(w.counters.asked, 30 - fired);
  });

  it("leavers during open bets leave their share of the margin; no cash-out lowers the price", () => {
    const w = runSim(
      config({
        rounds: 20,
        intern: { kind: "max" },
        run: { day: 5, days: 3, share: 0.9 },
        community: { ...SMALL_COMMUNITY, start_bosses: 30 },
      }),
    );
    assert.ok(w.counters.cashouts > 0);
    assert.ok(w.counters.forfeited > 0n);
    assert.ok(w.counters.max_cashout_price_drop <= 0n);
  });

  it("every scenario keeps its books, with and without the limits, on real prices", () => {
    const fx = prices();
    const clock = clockFor(1440);
    const start = windowStarts(fx.book, clock, 20)[0] ?? 0;
    const moves = moveTable(fx.book, clock, start, 20);
    for (const s of SCENARIOS) {
      for (const arm of ["limits", "control"] as const) {
        const w = runSim(
          config({
            rounds: 20,
            arm,
            moves,
            intern: s.intern === "max" ? { kind: "max" } : config().intern,
            asks: s.asks === "until-full" ? "until-full" : 1,
            community: { ...s.community, start_bosses: 10, new_bosses_per_day: 1 },
            whale: s.whale,
            fakes: s.fakes ? { ...s.fakes, count: 30 } : null,
            run: s.run ? { ...s.run, day: 8 } : null,
            losing: s.losing ? { from_round: 1, to_round: 10 } : null,
          }),
        );
        assert.deepEqual(w.counters.invariant_failures, [], `${s.name} ${arm}`);
        if (arm === "limits") assert.equal(w.counters.approved_over_limit, 0, s.name);
      }
    }
  });
});
