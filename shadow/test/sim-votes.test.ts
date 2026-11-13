import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyWaiting, cast, finishDue, openVote } from "../src/sim/ballots.ts";
import { lock } from "../src/sim/ledger.ts";
import {
  canFinishEarly,
  cannotOpen,
  effectiveRound,
  fullRounds,
  outcome,
  passed,
  type Tally,
  weightOf,
} from "../src/sim/votes.ts";
import { addAccount, inOpenVote, newWorld, type World } from "../src/sim/world.ts";

const t = (yes: number, no: number, locked = 1_000): Tally => ({
  yes: BigInt(yes),
  no: BigInt(no),
  locked_weight_at_open: BigInt(locked),
});

describe("vote weight grows over 7 rounds (01 §9.2)", () => {
  it("counts the full rounds strictly between the lock and the vote", () => {
    assert.equal(fullRounds(1, 1), 0);
    assert.equal(fullRounds(1, 2), 0);
    assert.equal(fullRounds(1, 3), 1);
    assert.equal(fullRounds(1, 9), 7);
    const lots = [{ amount: 700n, round: 1 }];
    assert.equal(weightOf(lots, 2), 0n, "no full round yet");
    assert.equal(weightOf(lots, 3), 100n);
    assert.equal(weightOf(lots, 5), 300n);
    assert.equal(weightOf(lots, 9), 700n);
    assert.equal(weightOf(lots, 50), 700n, "never above the coins locked");
    assert.equal(weightOf([{ amount: 700n, round: 9 }], 9), 0n, "locked in the vote's round: zero");
  });

  it("rounds down once over a boss's lots", () => {
    assert.equal(
      weightOf(
        [
          { amount: 3n, round: 1 },
          { amount: 4n, round: 2 },
        ],
        4,
      ),
      1n,
    );
  });
});

describe("pass rules (01 §9.2, 1.2), with the owner's test values", () => {
  it("promote, rehire, playbook: yes above half of the weight that voted, and 20% turnout", () => {
    for (const k of ["PROMOTE", "REHIRE", "SET_PLAYBOOK"] as const) {
      assert.ok(passed(k, t(151, 50)));
      assert.ok(!passed(k, t(100, 100)), "half is not more than half");
      assert.ok(!passed(k, t(150, 0)), "150 of 1,000 is under the 20% turnout");
      assert.ok(passed(k, t(200, 0)), "200 of 1,000 is 20% turnout");
    }
  });

  it("demote and fire: yes from 34% of all weight locked at the opening; no votes do not count", () => {
    for (const k of ["DEMOTE", "FIRE"] as const) {
      assert.ok(passed(k, t(340, 0)));
      assert.ok(passed(k, t(340, 660)), "no votes do not change the result");
      assert.ok(!passed(k, t(339, 0)));
      assert.ok(canFinishEarly(k, t(340, 0)));
      assert.ok(!canFinishEarly(k, t(339, 0)));
    }
    assert.ok(!canFinishEarly("PROMOTE", t(1_000, 0)));
  });

  it("a vote in which no weight voted fails, even with nothing locked (the contract's reading)", () => {
    assert.ok(!passed("FIRE", t(0, 0, 0)));
    assert.ok(!passed("PROMOTE", t(0, 0, 0)));
    assert.ok(!canFinishEarly("FIRE", t(0, 0, 0)));
  });

  it("effective rounds: loosening two rounds after it passed, tightening at once", () => {
    assert.equal(effectiveRound("PROMOTE", 10), 12);
    assert.equal(effectiveRound("REHIRE", 10), 12);
    assert.equal(effectiveRound("SET_PLAYBOOK", 10), 12);
    assert.equal(effectiveRound("FIRE", 10), 10);
    assert.equal(effectiveRound("DEMOTE", 10), 10);
  });

  it("opening rules (01 §9.2 1.1) and outcomes", () => {
    assert.equal(cannotOpen("REHIRE", "INTERN", "EMPLOYED", false), "rehire only while fired");
    assert.equal(cannotOpen("FIRE", "INTERN", "FIRED", false), "only while employed");
    assert.equal(cannotOpen("PROMOTE", "TRADER", "EMPLOYED", false), "no rank above TRADER");
    assert.equal(cannotOpen("DEMOTE", "INTERN", "EMPLOYED", false), "no rank below INTERN");
    assert.equal(cannotOpen("PROMOTE", "INTERN", "EMPLOYED", true), "a promotion is waiting");
    assert.equal(cannotOpen("SET_PLAYBOOK", "TRADER", "FIRED", false), null);
    assert.deepEqual(outcome("PROMOTE", "ANALYST", "EMPLOYED"), { rank: "TRADER", status: "EMPLOYED" });
    assert.deepEqual(outcome("DEMOTE", "ANALYST", "EMPLOYED"), { rank: "INTERN", status: "EMPLOYED" });
    assert.deepEqual(outcome("FIRE", "TRADER", "EMPLOYED"), { rank: "TRADER", status: "FIRED" });
    assert.deepEqual(outcome("REHIRE", "TRADER", "FIRED"), { rank: "INTERN", status: "EMPLOYED" });
  });
});

/** A world in round `round` with bosses holding the given locked lots. */
function worldWith(round: number, lots: [string, bigint, number][]): World {
  const w = newWorld();
  for (const [, amount, lockedIn] of lots) {
    const a = addAccount(w, "boss");
    a.coins = amount;
    lock(a, amount, lockedIn);
  }
  w.round = round;
  return w;
}

describe("votes on the simulated coin", () => {
  it("a promotion passes, waits one full round, then takes effect; a firing cancels it", () => {
    const w = worldWith(10, [
      ["a", 600n, 1],
      ["b", 400n, 1],
    ]);
    const [a, b] = w.accounts;
    if (!a || !b) throw new Error("two bosses");
    const v = openVote(w, "PROMOTE", a.id);
    assert.ok(v);
    assert.equal(openVote(w, "PROMOTE", b.id), null, "one open vote per kind");
    cast(w, v, a.id, true);
    assert.ok(inOpenVote(w, a.id), "a voter cannot unlock while the vote is open");
    w.round = 11;
    finishDue(w);
    assert.equal(v.state, "PASSED");
    assert.deepEqual(w.waiting, { kind: "PROMOTE", effective_round: 13 });
    // 01 §9.2 (1.1): a firing cancels a promotion still waiting; it acts at once, finished early at 34%.
    const fire = openVote(w, "FIRE", b.id);
    assert.ok(fire);
    cast(w, fire, b.id, true);
    assert.equal(fire.state, "PASSED", "400 of 1,000 is over 34%: finished early");
    assert.equal(w.status, "FIRED");
    assert.equal(w.waiting, null);
    w.round = 13;
    applyWaiting(w);
    assert.equal(w.rank, "INTERN");
    assert.deepEqual(
      w.counters.rank_changes.map((c) => c.to),
      ["FIRED"],
    );
  });

  it("coins locked too recently weigh nothing: a whale cannot act on fresh coins", () => {
    const w = worldWith(10, [
      ["old", 100n, 1],
      ["whale", 10_000n, 9],
    ]);
    const whale = w.accounts[1];
    if (!whale) throw new Error("whale");
    const v = openVote(w, "FIRE", whale.id);
    assert.ok(v);
    assert.equal(v.locked_weight_at_open, 100n, "the whale's lot has no full round yet");
    cast(w, v, whale.id, true);
    w.round = 11;
    finishDue(w);
    assert.equal(v.state, "FAILED");
    assert.equal(w.status, "EMPLOYED");
  });
});
