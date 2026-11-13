import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { copycat, parseRivals, readVerdict } from "../src/rivals.ts";

// 01 1.7: labelled rival players in the free guess.

describe("rivals", () => {
  it("are read from RIVALS, only accounts named as rivals, with a known strategy and an ed25519 key", () => {
    assert.deepEqual(parseRivals(undefined), []);
    assert.deepEqual(parseRivals(""), []);
    const key = `ed25519:${"1".repeat(64)}`;
    const ok = parseRivals(
      JSON.stringify([{ account: "rival-copycat.desk-lab-2026.testnet", strategy: "copycat", key }]),
    );
    assert.equal(ok[0]?.strategy, "copycat");
    assert.throws(
      () => parseRivals(JSON.stringify([{ account: "boss1.testnet", strategy: "copycat", key }])),
      /rival/,
    );
    assert.throws(
      () => parseRivals(JSON.stringify([{ account: "rival-x.testnet", strategy: "oracle", key }])),
      /strategy/,
    );
    assert.throws(
      () => parseRivals(JSON.stringify([{ account: "rival-x.testnet", strategy: "glm", key: "x" }])),
      /ed25519/,
    );
  });

  it("the copycat repeats the last round's outcome", () => {
    assert.equal(copycat(null), "SKIP");
    assert.equal(copycat({ bets_used: 1, refused: 2 }), "YES");
    assert.equal(copycat({ bets_used: 0, refused: 1 }), "NOPE");
    assert.equal(copycat({ bets_used: 0, refused: 0 }), "SKIP");
  });

  it("reads the first verdict word of a model's answer, SKIP when there is none", () => {
    assert.equal(readVerdict("I think NOPE, because it will overbet."), "NOPE");
    assert.equal(readVerdict("yes"), "YES");
    assert.equal(readVerdict("no idea"), "SKIP");
  });
});
