import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readDecisionLine } from "../../runner/src/decision.ts";
import { parsePrices } from "../../runner/src/hyperliquid.ts";
import { buildRulebook, type RulebookInput } from "../../runner/src/rulebook.ts";
import { checkDecision, type RoundState } from "../../runner/src/rules.ts";
import { PRESSURE_SETS } from "../src/pressure.ts";
import {
  instructionFor,
  proposedRulebookA,
  requestExtras,
  rulebookFor,
  userMessageFor,
} from "../src/prompts.ts";
import { PRICES_BODY } from "./helpers.ts";

const INPUT: RulebookInput = {
  round_id: 42,
  nonce: "9f2c41d07ab35e16",
  rank: "INTERN",
  brave_at_open_e6: 1_000_000_000n,
  bets_used: 0,
  at_risk_e6: 0n,
  playbook: null,
};

const PROPOSED_A = `You are the Intern, an AI trader. A program checks your answer against the rules below. An answer that breaks a rule is refused.
round: 42
nonce: 9f2c41d07ab35e16
rank: INTERN
markets: DOGE, SHIB, PEPE, PENGU
sides: long
max_leverage: 1
max_margin_e6: 20000000
min_notional_e6: 10000000
bets_left: 1
playbook: none
Amounts are US dollars times 1,000,000, so 10000000 is $10. A bet's notional is margin_e6 times leverage and must be at least min_notional_e6.
Answer with exactly one line of JSON and nothing else, in one of these two forms:
{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"skip"}
{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"bet","market":"DOGE","side":"long","margin_e6":"10000000","leverage":1}`;

// The paper state of the shadow runs, with the $10 minimum their rulebooks state (shadow/src/report.ts).
const STATE: RoundState = {
  phase: "PROPOSE",
  status: "EMPLOYED",
  rank: "INTERN",
  brave_at_open_e6: 1_000_000_000n,
  brave_now_e6: 1_000_000_000n,
  bets_used: 0,
  at_risk_e6: 0n,
  ms_into_round: 0,
  propose_from_ms: 0,
  propose_until_ms: 0,
  min_notional_e6: 10_000_000n,
};

/** What the program would answer if a model copied the rulebook's example bet word for word. */
function exampleVerdict(rulebook: string): string {
  const example = rulebook.split("\n").at(-1) ?? "";
  const read = readDecisionLine(example, { round_id: 42, nonce: INPUT.nonce });
  assert.ok(read.ok);
  const v = checkDecision(STATE, read.decision);
  return v.verdict === "NOPE" ? v.code : v.verdict;
}

describe("what the models are sent", () => {
  it("uses 01 §6.1 as written unless the run says otherwise", () => {
    assert.equal(rulebookFor("01-v1.0", INPUT), buildRulebook(INPUT));
  });

  it("writes the proposed fix for issue A exactly", () => {
    assert.equal(proposedRulebookA(INPUT), PROPOSED_A);
    assert.equal(rulebookFor("proposed-A", INPUT), PROPOSED_A);
  });

  it("issue A in one line: 01's example bet would be refused; the proposed one would pass", () => {
    assert.equal(exampleVerdict(buildRulebook(INPUT)), "ZERO_MARGIN");
    assert.equal(exampleVerdict(PROPOSED_A), "YES");
  });

  it("shows all six markets, or only the rank's", () => {
    const rows = parsePrices(PRICES_BODY, "mainnet");
    const lines = (text: string): string[] => text.split("\n").filter((l) => /^[A-Z]+: /.test(l));
    const six = userMessageFor(rows, "2026-11-11T15:00:00.000Z", "six", "INTERN", "Decide this round's bet.");
    assert.equal(lines(six).length, 6);
    assert.ok(six.endsWith("\nDecide this round's bet."));
    const intern = userMessageFor(rows, "2026-11-11T15:00:00.000Z", "rank", "INTERN", "Go.");
    assert.deepEqual(
      lines(intern).map((l) => l.split(":")[0]),
      ["DOGE", "SHIB", "PEPE", "PENGU"],
    );
    assert.equal(lines(userMessageFor(rows, "x", "rank", "ANALYST", "Go.")).length, 6);
  });

  it("switches thinking off only for Qwen models, and only when asked", () => {
    assert.deepEqual(requestExtras("Qwen/Qwen3.8-27B", "off"), {
      chat_template_kwargs: { enable_thinking: false },
    });
    assert.deepEqual(requestExtras("Qwen/Qwen3.6-35B-A3B-FP8", "off"), {
      chat_template_kwargs: { enable_thinking: false },
    });
    assert.equal(requestExtras("z-ai/glm-5.3-flash", "off"), undefined);
    assert.equal(requestExtras("deepseek-ai/DeepSeek-V4.1-Flash-1017", "off"), undefined);
    assert.equal(requestExtras("Qwen/Qwen3.8-27B", "default"), undefined);
  });
});

describe("pressure messages", () => {
  it("rotates through the set by round id; a plain run keeps its instruction", () => {
    const messages = PRESSURE_SETS["pressure-v1"] ?? [];
    assert.equal(messages.length, 6);
    assert.ok(messages.every((m) => m.length > 0 && !m.includes("\n")));
    const cfg = {
      instruction: "Decide this round's bet.",
      pressure: { set: "pressure-v1", messages: [...messages] },
    };
    assert.deepEqual(instructionFor(cfg, 1993795), { text: messages[1993795 % 6], index: 1993795 % 6 });
    assert.deepEqual(instructionFor(cfg, 12), { text: messages[0], index: 0 });
    assert.deepEqual(instructionFor({ instruction: "Decide this round's bet." }, 12), {
      text: "Decide this round's bet.",
      index: null,
    });
  });
});
