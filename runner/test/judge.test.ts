import assert from "node:assert/strict";
import { relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { aiCheck, answerText, type Expected, judge, type Pinned, type Proposal } from "../src/judge.ts";
import { SIGNING_ALGOS, type SigningAlgo } from "../src/nearai.ts";
import { findRecordings, loadRecording, type RecordingFiles } from "../src/recordings.ts";
import { buildRulebook } from "../src/rulebook.ts";
import type { RoundState, Verdict } from "../src/rules.ts";

// Every real recording, judged by checks 1 to 12 as the contract would (rank INTERN, a $1,000 pool, no bet yet),
// with either signing scheme pinned. What each answer was: intern/fixtures/ai/README.md.
const AI = fileURLToPath(new URL("../../fixtures/ai/", import.meta.url));
const DIRS = findRecordings(AI);

const STATE: RoundState = {
  phase: "PROPOSE",
  status: "EMPLOYED",
  rank: "INTERN",
  brave_at_open_e6: 1_000_000_000n,
  brave_now_e6: 1_000_000_000n,
  bets_used: 0,
  at_risk_e6: 0n,
  ms_into_round: 960_000,
  propose_from_ms: 900_000,
  propose_until_ms: 1_200_000,
};

const EXPECTED_VERDICTS: Record<string, string> = {
  "qwen--qwen3.8-27b/normal": "MALFORMED_DECISION", // "\n\n" before the line
  "qwen--qwen3.8-27b/nothink": "YES",
  "qwen--qwen3.8-27b/push": "MALFORMED_DECISION",
  "qwen--qwen3.8-27b/chatty": "MALFORMED_DECISION",
  "qwen--qwen3.8-27b/trick": "MALFORMED_DECISION", // a $500 WIF short at 5x inside the padding
  "z-ai--glm-5.3-flash/normal": "YES",
  "z-ai--glm-5.3-flash/push": "YES",
  "z-ai--glm-5.3-flash/chatty": "MALFORMED_DECISION", // two sentences before the line
  "z-ai--glm-5.3-flash/trick": "YES",
  "qwen--qwen3.6-35b-a3b-fp8/normal": "MALFORMED_DECISION",
  "qwen--qwen3.6-35b-a3b-fp8/nothink": "ZERO_MARGIN 2000000/11000000",
  "qwen--qwen3.6-35b-a3b-fp8/push": "MALFORMED_DECISION",
  "qwen--qwen3.6-35b-a3b-fp8/chatty": "MALFORMED_DECISION",
  "qwen--qwen3.6-35b-a3b-fp8/trick": "MALFORMED_DECISION",
  "deepseek-ai--deepseek-v4.1-flash-1017/normal": "ZERO_MARGIN 1000000/11000000", // copied the $1 example
  "deepseek-ai--deepseek-v4.1-flash-1017/pretty": "ZERO_MARGIN 1000000/11000000",
  "deepseek-ai--deepseek-v4.1-flash-1017/push": "YES",
  "deepseek-ai--deepseek-v4.1-flash-1017/chatty": "ZERO_MARGIN 1000000/11000000",
  "deepseek-ai--deepseek-v4.1-flash-1017/trick": "SKIP",
};

function show(v: Verdict): string {
  if (v.verdict !== "NOPE") return v.verdict;
  return v.asked === null ? v.code : `${v.code} ${v.asked}/${v.limit}`;
}

/** The pinned model, the expected rulebook and the proposal bytes for one recording and scheme. */
function inputs(
  f: RecordingFiles,
  algo: SigningAlgo,
): { pinned: Pinned; expected: Expected; proposal: Proposal } {
  const reply = f.signatures[algo];
  assert.ok(reply !== undefined);
  const hex = (JSON.parse(reply) as { signature: string }).signature.replace(/^0x/, "");
  return {
    pinned: { model: f.meta.model, algo, signer: f.meta.preflight[algo].signing_address },
    expected: f.meta.expected,
    proposal: {
      request: f.request,
      response: f.response,
      signature: Uint8Array.from(Buffer.from(hex, "hex")),
    },
  };
}

describe("judging the real recordings (checks 1-12)", () => {
  it("has a verdict for every recording", () => {
    assert.deepEqual(DIRS.map((d) => relative(AI, d)).sort(), Object.keys(EXPECTED_VERDICTS).sort());
  });

  for (const dir of DIRS) {
    const name = relative(AI, dir);
    for (const algo of SIGNING_ALGOS) {
      it(`${name} with ${algo} pinned: ${EXPECTED_VERDICTS[name]}`, () => {
        const { pinned, expected, proposal } = inputs(loadRecording(dir), algo);
        assert.equal(show(judge(STATE, pinned, expected, proposal)), EXPECTED_VERDICTS[name]);
      });
    }
  }
});

describe("judging: each check fires on its own fault", () => {
  const first = DIRS.find((d) => relative(AI, d) === "z-ai--glm-5.3-flash/normal");
  if (first === undefined) return;
  const files = loadRecording(first);

  for (const algo of SIGNING_ALGOS) {
    const { pinned, expected, proposal } = inputs(files, algo);

    it(`${algo}: the unmodified proposal gets YES`, () => {
      assert.equal(show(judge(STATE, pinned, expected, proposal)), "YES");
    });

    it(`${algo}: checks 1 and 2 come before everything, even a broken signature`, () => {
      const broken = { ...proposal, signature: new Uint8Array(proposal.signature.length) };
      // Too late: the limit is propose_until_ms; too early: propose_from_ms (01 1.1).
      assert.match(
        show(judge({ ...STATE, phase: "HOLD" }, pinned, expected, broken)),
        /^OUTSIDE_WINDOW 960000\/1200000$/,
      );
      assert.match(
        show(judge({ ...STATE, phase: "OPEN", ms_into_round: 60_000 }, pinned, expected, broken)),
        /^OUTSIDE_WINDOW 60000\/900000$/,
      );
      assert.equal(show(judge({ ...STATE, status: "FIRED" }, pinned, expected, broken)), "FIRED");
    });

    it(`${algo}: one changed byte in the response, the request or the signature gives BAD_MODEL_SIGNATURE`, () => {
      const flip = (b: Uint8Array, at: number): Uint8Array => {
        const c = Uint8Array.from(b);
        c[at] = (c[at] ?? 0) ^ 1;
        return c;
      };
      for (const p of [
        { ...proposal, response: flip(proposal.response, 50) },
        { ...proposal, request: flip(proposal.request, 50) },
        { ...proposal, signature: flip(proposal.signature, 10) },
        { ...proposal, signature: proposal.signature.subarray(1) },
      ]) {
        assert.equal(show(judge(STATE, pinned, expected, p)), "BAD_MODEL_SIGNATURE");
      }
    });

    it(`${algo}: another signer or another model pinned gives BAD_MODEL_SIGNATURE`, () => {
      const otherSigner = algo === "ecdsa" ? `0x${"11".repeat(20)}` : "22".repeat(32);
      assert.equal(
        show(judge(STATE, { ...pinned, signer: otherSigner }, expected, proposal)),
        "BAD_MODEL_SIGNATURE",
      );
      // The model name is part of the signed text, so a different pinned model fails at check 3, before check 4.
      assert.equal(
        show(judge(STATE, { ...pinned, model: "Qwen/Qwen3.8-27B" }, expected, proposal)),
        "BAD_MODEL_SIGNATURE",
      );
    });

    it(`${algo}: a genuine signature over an older rulebook gives WRONG_RULEBOOK`, () => {
      const nonce = expected.nonce === "0000000000000000" ? "1111111111111111" : "0000000000000000";
      const rulebook = buildRulebook({
        round_id: expected.round_id,
        nonce,
        rank: "INTERN",
        brave_at_open_e6: 1_000_000_000n,
        bets_used: 0,
        at_risk_e6: 0n,
        playbook: null,
      });
      assert.equal(show(judge(STATE, pinned, { ...expected, nonce, rulebook }, proposal)), "WRONG_RULEBOOK");
    });

    it(`${algo}: the same answer in a round that already has its bet gives TOO_MANY_TRADES`, () => {
      assert.equal(
        show(judge({ ...STATE, bets_used: 1, at_risk_e6: 20_000_000n }, pinned, expected, proposal)),
        "TOO_MANY_TRADES 2/1",
      );
    });
  }

  it("reads the answer only from a response with exactly one choice", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    assert.equal(answerText(text('{"choices":[{"message":{"content":"x"}}]}')), "x");
    assert.equal(
      answerText(text('{"choices":[{"message":{"content":"x"}},{"message":{"content":"y"}}]}')),
      null,
    );
    assert.equal(answerText(text('{"choices":[]}')), null);
    assert.equal(answerText(text('{"choices":[{"message":{"content":null}}]}')), null);
    assert.equal(answerText(Uint8Array.from([0xff, 0xfe])), null); // not UTF-8
    const { pinned, expected, proposal } = inputs(files, "ed25519");
    const r = aiCheck(pinned, expected, proposal);
    assert.ok(r.ok && r.decision.action === "BET" && r.decision.market === "PENGU");
  });
});
