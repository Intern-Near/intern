import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { RankName } from "../src/ranks.ts";
import { buildRulebook, buildRulebookV12, maxMarginE6, type RulebookInput } from "../src/rulebook.ts";

const BASE: RulebookInput = {
  round_id: 42,
  nonce: "9f2c41d07ab35e16",
  rank: "INTERN",
  brave_at_open_e6: 1_000_000_000n,
  bets_used: 0,
  at_risk_e6: 0n,
  playbook: null,
};

// 01-SHARED-INTERFACE.md §6.1 filled in for rank INTERN on a $1,000 pool, typed out by hand.
const INTERN_1000 = `You are the Intern, an AI trader. A program checks your answer against the rules below. An answer that breaks a rule is refused.
round: 42
nonce: 9f2c41d07ab35e16
rank: INTERN
markets: DOGE, SHIB, PEPE, PENGU
sides: long
max_leverage: 1
max_margin_e6: 20000000
bets_left: 1
playbook: none
Answer with exactly one line of JSON and nothing else, in one of these two forms:
{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"skip"}
{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"bet","market":"DOGE","side":"long","margin_e6":"1000000","leverage":1}`;

describe("rulebook (01 §6.1)", () => {
  it("matches the template byte for byte, with no trailing newline", () => {
    assert.equal(buildRulebook(BASE), INTERN_1000);
    assert.ok(!buildRulebook(BASE).endsWith("\n"));
  });

  it("lists TRADER's six markets and both sides, and caps the margin by what is left of the round", () => {
    const text = buildRulebook({ ...BASE, rank: "TRADER", bets_used: 2, at_risk_e6: 150_000_000n });
    assert.match(text, /\nmarkets: DOGE, SHIB, PEPE, PENGU, WIF, TRUMP\n/);
    assert.match(text, /\nsides: long, short\n/);
    assert.match(text, /\nmax_leverage: 2\n/);
    assert.match(text, /\nmax_margin_e6: 50000000\n/); // min($100 per bet, $200 - $150 left in the round)
    assert.match(text, /\nbets_left: 1\n/);
  });

  it("computes max_margin_e6 like 01 §3, rounding down, never below zero", () => {
    assert.equal(maxMarginE6({ ...BASE, rank: "ANALYST", bets_used: 2, at_risk_e6: 80_000_000n }), 0n);
    assert.equal(maxMarginE6({ ...BASE, brave_at_open_e6: 400_000_000n }), 8_000_000n); // test case 24's pool
    assert.equal(maxMarginE6({ ...BASE, brave_at_open_e6: 999_999n }), 19_999n); // 2% of $0.999999, rounded down
  });

  it("writes the playbook text, and refuses a playbook with a newline or a bad nonce", () => {
    assert.match(
      buildRulebook({ ...BASE, playbook: "Only bet on Mondays." }),
      /\nplaybook: Only bet on Mondays\.\n/,
    );
    assert.throws(() => buildRulebook({ ...BASE, playbook: "two\nlines" }), /one line/);
    assert.throws(() => buildRulebook({ ...BASE, nonce: "9F2C41D07AB35E16" }), /nonce/);
    assert.throws(() => buildRulebook({ ...BASE, nonce: "9f2c" }), /nonce/);
  });
});

describe("01 1.2 §6.1, against Engine 1's rulebook cases in checks.json", () => {
  const checks = JSON.parse(
    readFileSync(new URL("../../interface/vectors/checks.json", import.meta.url), "utf8"),
  ) as {
    interface_version: string;
    min_notional: string;
    rulebook_cases: {
      cases: {
        id: string;
        state: {
          round_id: number;
          nonce: string;
          rank: RankName;
          brave_at_open: string;
          brave_now: string;
          bets_used: number;
          at_risk: string;
          playbook: string | null;
        };
        text: string;
      }[];
    };
  };

  it("has the three cases R1 to R3 of version 1.2", () => {
    assert.equal(checks.interface_version, "1.4");
    assert.deepEqual(
      checks.rulebook_cases.cases.map((c) => c.id),
      ["R1", "R2", "R3"],
    );
  });

  for (const c of checks.rulebook_cases.cases) {
    it(`${c.id}: byte for byte (brave_now ignored, as 01 says)`, () => {
      const text = buildRulebookV12(
        {
          round_id: c.state.round_id,
          nonce: c.state.nonce,
          rank: c.state.rank,
          brave_at_open_e6: BigInt(c.state.brave_at_open),
          bets_used: c.state.bets_used,
          at_risk_e6: BigInt(c.state.at_risk),
          playbook: c.state.playbook,
        },
        BigInt(checks.min_notional),
      );
      assert.equal(text, c.text);
      assert.equal(text.split("\n").length, 15);
    });
  }
});
