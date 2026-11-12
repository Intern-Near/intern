import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pxArg } from "../src/chain.ts";
import {
  readConstants,
  readOutbox,
  readPositions,
  readRankState,
  readRound,
  readRulebook,
  readVerdict,
} from "../src/contract.ts";
import { fakeConstants } from "./support/fake-chain.ts";

// The strict readers of the program's answers, on 01 §8.2's sample answers (the stub returns these) and on
// answers in 01 §8.1's shapes.

describe("01 §8.2 sample answers", () => {
  it("get_rank", () => {
    const v = readRankState(
      JSON.parse('{"rank":"INTERN","status":"EMPLOYED","since_round":1,"pending":null}'),
    );
    assert.deepEqual(v, { rank: "INTERN", status: "EMPLOYED", since_round: 1 });
  });

  it("get_round", () => {
    const v = readRound(
      JSON.parse(`{"id":42,"phase":"HOLD","settled":false,"stuck":false,
 "started_at":1794355200000,"guess_closes_at":1794398100000,"propose_from":1794398400000,
 "propose_until":1794402000000,"close_from":1794434400000,"ends_at":1794441600000,
 "rank":"INTERN","status":"EMPLOYED","brave_at_open":"1000000000",
 "bets_used":1,"at_risk":"20000000","skipped":0,"refused":2,"result":null}`),
    );
    assert.equal(v.id, 42);
    assert.equal(v.phase, "HOLD");
    assert.equal(v.at_risk, "20000000");
    assert.equal(v.result, null);
  });

  it("get_positions", () => {
    const [p] = readPositions(
      JSON.parse(`[{"id":7,"round_id":42,"market":"DOGE","side":"LONG","margin":"20000000","leverage":1,
  "notional":"20000000","status":"OPEN_SIGNED","approved_at":1794398460000,
  "open_signed_at":1794398481000,"close_signed_at":null,"settled_at":null,
  "sz_e8":"29300000000","returned":null,"result":null,"result_source":null}]`),
    );
    assert.equal(p?.status, "OPEN_SIGNED");
    assert.equal(p?.sz_e8, "29300000000");
  });
});

describe("strictness", () => {
  const round = {
    id: 1,
    phase: "PROPOSE",
    settled: false,
    stuck: false,
    started_at: 0,
    propose_from: 1,
    propose_until: 2,
    close_from: 3,
    ends_at: 4,
    rank: "INTERN",
    status: "EMPLOYED",
    brave_at_open: "1000000000",
    bets_used: 0,
    at_risk: "0",
    skipped: 0,
    refused: 0,
    result: null,
  };

  it("a U128 written as a JSON number is refused (01 §2: never a JSON number)", () => {
    assert.throws(
      () => readRound({ ...round, brave_at_open: 1000000000 }),
      /brave_at_open: expected a string/,
    );
    assert.throws(() => readRound({ ...round, at_risk: "01" }), /at_risk: expected a decimal string/);
  });

  it("a missing field or an unknown enum value is refused, naming the field", () => {
    const { phase: _p, ...noPhase } = round;
    assert.throws(() => readRound(noPhase), /get_round\.phase/);
    assert.throws(() => readRound({ ...round, rank: "INTERNED" }), /get_round\.rank: expected one of/);
    assert.throws(() => readRound({ ...round, result: "1.5" }), /signed decimal string/);
  });

  it("get_constants in 01 §8.1's shape", () => {
    const c = fakeConstants({ id: "z-ai/glm-5.3-flash", signing_algo: "ed25519", signer: "ab".repeat(32) });
    const wire = JSON.parse(
      JSON.stringify({
        ...c,
        lending: { mode: "STANDIN" },
        coin_decimals: 6,
        coach_cut_bps: 1000,
        extra: true,
      }),
    );
    // 1.3 added fields the runner does not use (coach_cut_bps, goals, stickers, launchpad): they are allowed.
    assert.deepEqual(readConstants(wire), { ...c, lending_mode: "STANDIN" });
    const { lending: _lending, ...noLending } = wire;
    assert.equal(readConstants(noLending).lending_mode, null);
    assert.equal(readConstants(wire).min_notional, "11000000");
    assert.throws(
      () => readConstants({ ...wire, min_notional: 11000000 }),
      /min_notional: expected a string/,
    );
    assert.throws(
      () => readConstants({ ...wire, ranks: [{ ...wire.ranks[0], sides: ["UP"] }] }),
      /sides\[0\]/,
    );
  });

  it("the rulebook nonce must be 16 lower-case hex characters", () => {
    assert.equal(
      readRulebook({ round_id: 3, nonce: "9f2c41d07ab35e16", text: "x" }).nonce,
      "9f2c41d07ab35e16",
    );
    assert.throws(() => readRulebook({ round_id: 3, nonce: "9F2C41D07AB35E16", text: "x" }), /nonce/);
  });

  it("verdicts", () => {
    assert.deepEqual(readVerdict({ verdict: "YES", position_id: 7 }), { verdict: "YES", position_id: 7 });
    assert.deepEqual(readVerdict({ verdict: "SKIP" }), { verdict: "SKIP" });
    assert.deepEqual(
      readVerdict({
        verdict: "NOPE",
        refusal_id: 31,
        code: "OVER_TRADE_LIMIT",
        asked: "450000000",
        limit: "20000000",
      }),
      { verdict: "NOPE", refusal_id: 31, code: "OVER_TRADE_LIMIT", asked: "450000000", limit: "20000000" },
    );
    assert.throws(() =>
      readVerdict({ verdict: "NOPE", refusal_id: 1, code: "TOO_RISKY", asked: null, limit: null }),
    );
  });

  it("signed actions: r and s are 0x plus 64 hex characters", () => {
    const a = {
      id: 1,
      position_id: 7,
      kind: "OPEN",
      action: { type: "order" },
      nonce: 1794375990906,
      expires_after: 1794376110906,
      signature: { r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}`, v: 27 },
      created_at: 1794375990906,
    };
    assert.equal(readOutbox([a])[0]?.kind, "OPEN");
    assert.throws(() => readOutbox([{ ...a, signature: { ...a.signature, r: "0xab" } }]), /r and s/);
  });
});

describe("px_e8 in sign_next and close (01 1.2: a decimal string)", () => {
  it("is written as a decimal string by default", () => {
    assert.equal(pxArg(6_986_100n), "6986100");
    assert.equal(pxArg(6_986_100n, "string"), "6986100");
    assert.equal(pxArg(6_986_100n, "number"), 6986100);
    assert.throws(() => pxArg(0n, "string"), /positive/);
  });
});
