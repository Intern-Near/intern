import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  braveValue,
  cashOutBrave,
  coinPriceE6,
  dialToBrave,
  dialToSafe,
  freeCoins,
  lock,
  newAccount,
  newPot,
  openRound,
  payIn,
  takeBackPending,
  unlock,
} from "../src/sim/ledger.ts";
import { Rng } from "../src/sim/rng.ts";

// The expected numbers are the owner's own, from the tests in crates/rules/src/shares.rs.

describe("coins at a round's opening (01 §5, §9.1)", () => {
  it("the first conversion locks 1,000 units for ever", () => {
    const pot = newPot();
    const a = newAccount("a", "boss");
    payIn(pot, a, "BRAVE", 1_000_000_000n);
    openRound(pot, [a], 1);
    assert.equal(pot.supply, 1_000_000_000n);
    assert.equal(a.coins, 999_999_000n);
    assert.equal(pot.nobodys, 1_000n);
    assert.equal(a.joined_round, 1);
    assert.equal(coinPriceE6(pot), 1_000_000n);
  });

  it("two first depositors share the locked units", () => {
    const pot = newPot();
    const a = newAccount("a", "boss");
    const b = newAccount("b", "boss");
    payIn(pot, a, "BRAVE", 10_000_000n);
    payIn(pot, b, "BRAVE", 20_000_000n);
    openRound(pot, [a, b], 1);
    assert.deepEqual([a.coins, b.coins], [9_999_666n, 19_999_333n]);
    assert.equal(a.coins + b.coins + pot.nobodys, pot.supply);
  });

  it("a first deposit under the minimum waits; so does money worth under one unit", () => {
    const pot = newPot();
    const a = newAccount("a", "boss");
    payIn(pot, a, "BRAVE", 9_999_999n);
    assert.equal(openRound(pot, [a], 1).minted, 0n);
    assert.equal(a.pending, 9_999_999n);
    const pot2 = { ...newPot(), brave_total: 3_000_000n, supply: 1_000_000n };
    const b = newAccount("b", "boss");
    payIn(pot2, b, "BRAVE", 2n);
    assert.equal(openRound(pot2, [b], 5).minted, 0n);
    assert.equal(b.pending, 2n);
  });

  it("later money gets coins at the price of the opening; income is credited first (01 §9.6)", () => {
    const pot = { ...newPot(), brave_total: 2_000_000n, supply: 1_000_000n, nobodys: 1_000_000n };
    const a = newAccount("a", "boss");
    payIn(pot, a, "BRAVE", 1_000n);
    assert.equal(openRound(pot, [a], 3).minted, 500n);
    assert.equal(a.coins, 500n);
    const pot2 = {
      ...newPot(),
      brave_total: 2_000_000n,
      supply: 1_000_000n,
      nobodys: 1_000_000n,
      income_waiting: 2_000_000n,
    };
    const b = newAccount("b", "boss");
    payIn(pot2, b, "BRAVE", 1_000n);
    openRound(pot2, [b], 3);
    assert.equal(b.coins, 250n, "the income made each coin dearer before the new money bought in");
  });
});

describe("cash-out (01 §9.1)", () => {
  it("leaves out the margin on open bets", () => {
    const pot = { ...newPot(), brave_total: 1_000_000_000n, in_play: 20_000_000n, supply: 1_000_000_000n };
    const a = { ...newAccount("a", "boss"), coins: 250_000_000n };
    pot.nobodys = 750_000_000n;
    assert.equal(coinPriceE6(pot), 980_000n);
    assert.equal(braveValue(pot, a.coins), 245_000_000n);
    assert.equal(cashOutBrave(pot, a, 250_000_000n), 245_000_000n);
    assert.equal(pot.brave_total, 755_000_000n);
  });

  it("never lowers the coin price for those who stay", () => {
    const rng = new Rng(11);
    for (let i = 0; i < 2_000; i++) {
      const supply = BigInt(1 + rng.int(1e9));
      const pot = {
        ...newPot(),
        brave_total: BigInt(rng.int(2e9)),
        in_play: 0n,
        supply,
        nobodys: 1_000n,
      };
      pot.in_play = (pot.brave_total * BigInt(rng.int(50))) / 100n;
      const a = { ...newAccount("a", "boss"), coins: supply - 1_000n > 0n ? supply - 1_000n : 0n };
      const coins = a.coins === 0n ? 0n : 1n + BigInt(rng.int(Number(a.coins)));
      const before = coinPriceE6(pot);
      cashOutBrave(pot, a, coins);
      assert.ok(coinPriceE6(pot) >= before, `round ${i}: the price fell`);
    }
  });

  it("refuses locked coins; unlocks newest lots first", () => {
    const a = { ...newAccount("a", "boss"), coins: 100n };
    lock(a, 30n, 1);
    lock(a, 20n, 2);
    lock(a, 5n, 2);
    assert.deepEqual(a.lots, [
      { amount: 30n, round: 1 },
      { amount: 25n, round: 2 },
    ]);
    assert.equal(freeCoins(a), 45n);
    const pot = { ...newPot(), brave_total: 100n, supply: 100n };
    assert.throws(() => cashOutBrave(pot, a, 46n), /free/);
    unlock(a, 30n);
    assert.deepEqual(a.lots, [{ amount: 25n, round: 1 }]);
  });

  it("pending money can be taken back; the dial moves money without it leaving", () => {
    const pot = { ...newPot(), brave_total: 1_000n, supply: 1_000n };
    const a = { ...newAccount("a", "boss"), coins: 1_000n };
    payIn(pot, a, "BRAVE", 50n);
    assert.equal(takeBackPending(pot, a, 80n), 50n);
    assert.equal(pot.pending, 0n);
    dialToSafe(pot, a, 400n);
    assert.equal(a.safe, 400n);
    assert.equal(pot.safe_total, 400n);
    assert.equal(a.paid_out, 50n, "only the pending money left");
    dialToBrave(pot, a, 100n);
    assert.equal(a.pending, 100n);
    assert.equal(pot.pending, 100n);
    assert.equal(a.safe, 300n);
  });
});
