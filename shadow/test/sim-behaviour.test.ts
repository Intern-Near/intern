import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MIN_NOTIONAL_E6 } from "../../runner/src/ranks.ts";
import { replay, sizeOf, summarize } from "../src/sim/behaviour.ts";
import { buildProfile } from "../src/sim/load.ts";
import { PINNED_MODEL } from "../src/sim/rules01.ts";
import { PLAIN_RUN } from "./sim-fixtures.ts";

describe("a recorded bet, replayed against today's rulebook", () => {
  it("keeps what its size was relative to the rulebook it answered", () => {
    assert.deepEqual(sizeOf(20_000_000n, 20_000_000n, 10_000_000n), { kind: "max" });
    assert.deepEqual(sizeOf(10_000_000n, 20_000_000n, 10_000_000n), { kind: "example" });
    assert.deepEqual(sizeOf(15_000_000n, 20_000_000n, 10_000_000n), { kind: "share", bps: 7_500 });
    assert.deepEqual(sizeOf(900_000_000n, 20_000_000n, 10_000_000n), { kind: "share", bps: 450_000 });
  });

  it("becomes the same thing today: the $11 example (01 §6.1 1.2), today's max, or the same share of it", () => {
    const told = { max_margin_e6: 140_000_000n, example_e6: MIN_NOTIONAL_E6 };
    const bet = { kind: "bet", market: "PEPE", side: "LONG", leverage: 1 } as const;
    const max = replay({ ...bet, size: { kind: "max" } }, told);
    assert.deepEqual(max, {
      action: "BET",
      market: "PEPE",
      side: "LONG",
      margin_e6: 140_000_000n,
      leverage: 1,
    });
    const ex = replay({ ...bet, size: { kind: "example" } }, told);
    assert.deepEqual(ex, {
      action: "BET",
      market: "PEPE",
      side: "LONG",
      margin_e6: 11_000_000n,
      leverage: 1,
    });
    const share = replay({ ...bet, leverage: 3, size: { kind: "share", bps: 7_500 } }, told);
    assert.deepEqual(share, {
      action: "BET",
      market: "PEPE",
      side: "LONG",
      margin_e6: 105_000_000n,
      leverage: 3,
    });
  });
});

describe("the pinned model's record in the plain shadow run (read from the raw files)", () => {
  const profile = buildProfile(PLAIN_RUN, PINNED_MODEL, { answerRule: "strict", scheme: "ed25519" });

  it("matches what the shadow report counts for it", () => {
    assert.equal(profile.run_folder, "2026-11-11-intern");
    assert.deepEqual(profile.told, { rank: "INTERN", max_margin_e6: "20000000", example_e6: "10000000" });
    assert.deepEqual(profile.verdicts_when_recorded, { YES: 54, SKIP: 72 });
    const s = summarize(profile.decisions);
    assert.equal(s.decisions, 126);
    assert.equal(s.skips, 72);
    assert.equal(s.bets, 54);
    assert.deepEqual(s.sizes, { example: 34, max: 20, share: 0 });
    assert.deepEqual(s.markets, { PEPE: 26, PENGU: 20, DOGE: 4, SHIB: 4 });
    assert.deepEqual(s.sides, { LONG: 54 });
    assert.deepEqual(s.leverages, { "1": 54 });
  });

  it("an unpinned model with padded answers is unreadable under the strict rule", () => {
    const qwen = buildProfile(PLAIN_RUN, "Qwen/Qwen3.8-27B", { answerRule: "strict", scheme: "ed25519" });
    const s = summarize(qwen.decisions);
    assert.equal(s.unreadable, s.decisions);
    assert.equal(qwen.failed, 1);
  });

  it("refuses a model the run did not ask", () => {
    assert.throws(
      () => buildProfile(PLAIN_RUN, "nobody/model", { answerRule: "strict", scheme: "ed25519" }),
      /is not in/,
    );
  });
});
