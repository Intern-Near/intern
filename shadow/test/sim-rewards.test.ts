import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addToJackpot,
  collectInterest,
  enterDraw,
  guess,
  holdDraw,
  newRewards,
  playerOf,
  resolveGuess,
  ruling,
  settleJackpots,
  tip,
} from "../src/sim/rewards.ts";
import { Rng } from "../src/sim/rng.ts";
import { REWARDS } from "../src/sim/rules01.ts";

describe("the free guess and the streak jackpot (01 §9.7 R1, R3)", () => {
  it("seven right in a row win the jackpot, split between the round's winners; dust rolls over", () => {
    const rw = newRewards();
    addToJackpot(rw, 100_000_001n);
    const rng = new Rng(1);
    for (let r = 1; r <= 7; r++) {
      guess(rw, "a", r, "SKIP", true, rng);
      guess(rw, "b", r, "SKIP", true, rng);
      ruling(rw, r, "SKIP");
      ruling(rw, r, "YES"); // only the first ruling counts
      settleJackpots(rw, r + 1);
    }
    assert.deepEqual(rw.jackpot_wins, [{ round: 7, winners: ["a", "b"], each: 50_000_000n }]);
    assert.equal(rw.jackpot, 1n);
    resolveGuess(rw, playerOf(rw, "a"), 8);
    assert.equal(playerOf(rw, "a").streak, 0, "a completed streak starts again (the contract's reading)");
    assert.equal(playerOf(rw, "a").points, 7);
  });

  it("only eligible bosses win; a wrong guess resets; no ruling counts nothing; no guess pauses", () => {
    const rw = newRewards();
    addToJackpot(rw, 70n);
    const rng = new Rng(2);
    const play = (r: number, g: "YES" | "SKIP" | null, v: "YES" | "SKIP" | null, eligible = true): void => {
      if (g) guess(rw, "p", r, g, eligible, rng);
      if (v) ruling(rw, r, v);
    };
    play(1, "YES", "YES");
    play(2, "YES", "SKIP"); // wrong: resets
    play(3, "YES", null); // no ruling: nothing
    play(4, null, "YES"); // not guessed: paused
    resolveGuess(rw, playerOf(rw, "p"), 5);
    assert.equal(playerOf(rw, "p").streak, 0);
    assert.equal(playerOf(rw, "p").right, 1);
    assert.equal(playerOf(rw, "p").wrong, 1);
    for (let r = 5; r <= 11; r++) play(r, "YES", "YES", r !== 11);
    settleJackpots(rw, 12);
    assert.equal(rw.jackpot_wins.length, 0, "not eligible on the seventh guess");
    assert.equal(rw.jackpot, 70n);
  });

  it("half of a tip goes to the jackpot, half back for the pool (01 §9.5 1.4)", () => {
    const rw = newRewards();
    assert.equal(tip(rw, 3_000_001n), 1_500_001n);
    assert.equal(rw.jackpot, 1_500_000n);
  });
});

describe("the payday draw (01 §9.7 R4)", () => {
  it("tickets are the smaller of the dollars at the start and now, times the rounds in; 70% / 30% to runners-up", () => {
    const rw = newRewards();
    const usd: Record<string, bigint> = { a: 100n, b: 50n, c: 10n };
    enterDraw(rw, "a", 100n, 1);
    enterDraw(rw, "b", 80n, 1);
    enterDraw(rw, "c", 10n, 5);
    collectInterest(rw, 1_000n);
    assert.equal(
      holdDraw(rw, 7, (id) => usd[id] ?? 0n, new Rng(3)),
      null,
      "not before the period ends",
    );
    const d = holdDraw(rw, 8, (id) => usd[id] ?? 0n, new Rng(3));
    assert.ok(d);
    assert.equal(d.tickets_total, 100n * 7n + 50n * 7n + 10n * 3n);
    assert.equal(d.winner_prize, 700n);
    assert.equal(d.runners_up.length, 2);
    assert.equal(d.each, 150n);
    assert.equal(rw.draw_pot, 0n);
    const winners = [d.winner, ...d.runners_up].sort();
    assert.deepEqual(winners, ["a", "b", "c"], "each account wins once");
  });

  it("alone, the winner takes all; with nobody in it, the pot rolls over", () => {
    const rw = newRewards();
    collectInterest(rw, 500n);
    const empty = holdDraw(rw, 8, () => 0n, new Rng(4));
    assert.equal(empty?.winner, null);
    assert.equal(rw.draw_pot, 500n);
    enterDraw(rw, "a", 10n, 8);
    const d = holdDraw(rw, 15, () => 10n, new Rng(4));
    assert.equal(d?.winner, "a");
    assert.equal(d?.winner_prize, 500n);
  });

  it("at most 200 entrants: the rest are turned away", () => {
    const rw = newRewards();
    for (let i = 0; i < REWARDS.max_entrants; i++) assert.equal(enterDraw(rw, `f${i}`, 1n, 1), "IN");
    assert.equal(enterDraw(rw, "late", 1_000_000n, 1), "FULL");
    assert.deepEqual(rw.refused_full, ["late"]);
  });
});
