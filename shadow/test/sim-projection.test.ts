import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../runner/src/round.ts";
import { moveTable, windowStarts } from "../src/sim/prices.ts";
import { fastForward, type PotView, type ProjectionInput } from "../src/sim/projection.ts";
import { clockFor } from "../src/sim/rules01.ts";
import { prices, SOME_ANSWERS, view } from "./sim-fixtures.ts";

// fastForward from the live testnet coin's public state, saved on 2026-11-13 (get_pot, get_rank).

function input(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  const fx = prices();
  const clock = clockFor(1440);
  const start = windowStarts(fx.book, clock, 30)[0] ?? 0;
  return {
    pot: view("get_pot") as PotView,
    rank: view("get_rank") as ProjectionInput["rank"],
    round_minutes: 1440,
    decisions: SOME_ANSWERS,
    moves: moveTable(fx.book, clock, start, 30),
    cost_bps: 17,
    ...overrides,
  };
}

describe("fastForward: a state and N days in, a projected state out", () => {
  it("is labelled a projection", () => {
    const p = fastForward(input(), 10);
    assert.equal(p.label, "PROJECTION");
    assert.match(p.note, /Not a forecast/);
    assert.equal(p.daily.length, 10);
  });

  it("starts from the state given: the live coin's pot and rank", () => {
    const p = fastForward(input(), 0);
    const pot = view("get_pot") as PotView;
    assert.equal(p.start.brave_e6, pot.brave.total);
    assert.equal(p.start.supply_e6, pot.coin_supply);
    assert.equal(p.start.bosses, pot.bosses);
    assert.deepEqual(p.end, p.start, "zero days changes nothing");
  });

  it("is pure: the same input gives the same output, and the input is not changed", () => {
    const i = input();
    const before = JSON.stringify(i, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    const a = fastForward(i, 20);
    const b = fastForward(i, 20);
    assert.deepEqual(a, b);
    assert.equal(
      JSON.stringify(i, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
      before,
    );
    assert.notDeepEqual(fastForward({ ...i, seed: 2 }, 20).daily, a.daily);
  });

  it("repeats the price moves when the projection is longer than they are; the demo clock works too", () => {
    const p = fastForward(input(), 45);
    assert.equal(p.daily.length, 45);
    const fx = prices();
    const demo = clockFor(30);
    const start = windowStarts(fx.book, demo, 48)[0] ?? 0;
    const d = fastForward(input({ round_minutes: 30, moves: moveTable(fx.book, demo, start, 48) }), 2);
    assert.equal(d.daily.length, 2);
  });

  it("asks once a round by default, as the runner does", () => {
    assert.equal(DEFAULT_SETTINGS.maxAsks, 1);
  });
});
