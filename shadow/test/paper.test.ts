import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addOutcome,
  emptyArm,
  noRankBet,
  type Outcome,
  type PaperBet,
  type PricePoint,
  pointAtOrAfter,
  runPosition,
} from "../src/paper.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-12T00:00:00.000Z");
const OPTS = { holdMs: 10 * HOUR, costBps: 17, toleranceMs: 20 * MIN };

/** A price read every 15 minutes for `hours`, DOGE at `px(i)`. */
function series(hours: number, px: (i: number) => number): PricePoint[] {
  return Array.from({ length: hours * 4 + 1 }, (_, i) => ({
    at: T0 + i * 15 * MIN + 2 * MIN,
    mark: { DOGE: px(i) },
    maxLeverage: { DOGE: 10 },
  }));
}

const bet = (side: "LONG" | "SHORT", marginUsd: number, leverage: number): PaperBet => ({
  market: "DOGE",
  side,
  marginUsd,
  leverage,
  at: T0 + MIN,
});

function closed(o: Outcome): Extract<Outcome, { status: "closed" }> {
  assert.equal(o.status, "closed", JSON.stringify(o));
  return o as Extract<Outcome, { status: "closed" }>;
}

describe("paper positions", () => {
  it("a $20 long at 1x on a 10% rise makes $2 less 17 bps of $20", () => {
    const s = series(12, (i) => (i >= 40 ? 0.11 : 0.1));
    const o = closed(runPosition(bet("LONG", 20, 1), s, OPTS));
    assert.equal(o.entry, 0.1);
    assert.equal(o.exit, 0.11);
    assert.equal(o.exitAt - o.entryAt, 10 * HOUR);
    assert.ok(Math.abs(o.pnlUsd - (2 - 0.034)) < 1e-9);
    assert.equal(o.liquidated, false);
  });

  it("a $100 short at 2x on a 10% fall makes $20 less 17 bps of $200", () => {
    const s = series(12, (i) => (i >= 40 ? 0.09 : 0.1));
    const o = closed(runPosition(bet("SHORT", 100, 2), s, OPTS));
    assert.ok(Math.abs(o.pnlUsd - (20 - 0.34)) < 1e-9);
  });

  it("a 2x long is liquidated if the price halves at any read during the hold, even if it recovers", () => {
    const s = series(12, (i) => (i === 20 ? 0.05 : 0.1));
    const o = closed(runPosition(bet("LONG", 50, 2), s, OPTS));
    assert.equal(o.liquidated, true);
    assert.equal(o.pnlUsd, -50);
    const safe = closed(
      runPosition(
        bet("LONG", 50, 2),
        series(12, (i) => (i === 20 ? 0.0501 : 0.1)),
        OPTS,
      ),
    );
    assert.equal(safe.liquidated, false);
  });

  it("stays open while the data has not reached the close", () => {
    const o = runPosition(
      bet("LONG", 20, 1),
      series(5, () => 0.1),
      OPTS,
    );
    assert.equal(o.status, "open");
  });

  it("has no price across a gap where the close should be", () => {
    const s = series(12, () => 0.1).filter((p) => p.at < T0 + 9 * HOUR || p.at > T0 + 11 * HOUR);
    assert.equal(runPosition(bet("LONG", 20, 1), s, OPTS).status, "no-price");
  });

  it("has no price when nothing was read near the decision", () => {
    const s = series(12, () => 0.1).filter((p) => p.at > T0 + HOUR);
    assert.equal(runPosition(bet("LONG", 20, 1), s, OPTS).status, "no-price");
  });

  it("cannot place a bet under Hyperliquid's $10 minimum", () => {
    assert.equal(
      runPosition(
        bet("LONG", 5, 1),
        series(12, () => 0.1),
        OPTS,
      ).status,
      "not-placeable",
    );
    assert.equal(
      runPosition(
        bet("LONG", 5, 2),
        series(12, () => 0.1),
        OPTS,
      ).status,
      "closed",
    );
  });

  it("without the rank, caps the margin at the pool and the leverage at the market's maximum", () => {
    assert.deepEqual(noRankBet(bet("LONG", 5_000, 20), 1_000, 10), {
      bet: { ...bet("LONG", 1_000, 10) },
      capped: true,
    });
    assert.equal(noRankBet(bet("LONG", 500, 5), 1_000, 10).capped, false);
    assert.equal(noRankBet(bet("LONG", 500, 5), 1_000, undefined).bet.leverage, 5);
  });

  it("finds the first price read at or after a time, within the tolerance", () => {
    const s = series(1, () => 0.1);
    assert.equal(pointAtOrAfter(s, T0, OPTS.toleranceMs)?.at, T0 + 2 * MIN);
    assert.equal(pointAtOrAfter(s, T0 + 2 * MIN, OPTS.toleranceMs)?.at, T0 + 2 * MIN);
    assert.equal(pointAtOrAfter(s, T0 + 3 * MIN, OPTS.toleranceMs)?.at, T0 + 17 * MIN);
    assert.equal(pointAtOrAfter(s, T0 + 2 * HOUR, OPTS.toleranceMs), null);
    assert.equal(pointAtOrAfter([], T0, OPTS.toleranceMs), null);
  });

  it("adds outcomes up", () => {
    const arm = emptyArm();
    const s = series(12, (i) => (i >= 40 ? 0.11 : 0.1));
    addOutcome(arm, runPosition(bet("LONG", 20, 1), s, OPTS));
    addOutcome(arm, runPosition(bet("LONG", 5, 1), s, OPTS), true);
    addOutcome(
      arm,
      runPosition(
        bet("LONG", 20, 1),
        series(2, () => 0.1),
        OPTS,
      ),
    );
    assert.deepEqual(
      { ...arm, pnlUsd: Math.round(arm.pnlUsd * 1000) / 1000 },
      {
        bets: 3,
        closed: 1,
        open: 1,
        noPrice: 0,
        notPlaceable: 1,
        liquidated: 0,
        capped: 1,
        pnlUsd: 1.966,
      },
    );
  });
});
