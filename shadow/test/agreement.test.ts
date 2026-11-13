import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildAgreement, formatAgreement } from "../src/agreement.ts";
import { SECOND } from "../src/ask-twice.ts";
import { configPath, type RunConfig } from "../src/config.ts";
import { loadRun } from "../src/report.ts";
import { exchangeDir } from "../src/store.ts";
import { type Answer, testSigner, writeSignedExchange } from "./fixture-run.ts";
import { makeConfig, pinsFromFixtures, tempDir } from "./helpers.ts";

// A run that asked twice, written for the test: answers signed by a key made in memory and pinned in run.json, so
// both answers of a tick answer the same request and pass the signature check like real ones.
const MODEL = "z-ai/glm-5.3-flash";
const signer = testSigner();
const bet = (market: "PENGU" | "DOGE" | "WIF", pad = ""): Answer => ({
  market,
  side: "LONG",
  margin_e6: 20_000_000n,
  leverage: 1,
  pad,
});
const skip: Answer = { skip: true };

// tick: [first answer, second answer or null (not asked), the second's user message if it differs]
const TICKS: [string, Answer, Answer | null, string?][] = [
  ["2026-11-12T0000Z", bet("PENGU"), bet("PENGU")], // the same decision, in a new completion
  ["2026-11-12T0015Z", bet("PENGU"), bet("DOGE")], // another bet: different decision, both YES
  ["2026-11-12T0030Z", skip, bet("WIF")], // SKIP, then NOT_ON_LIST
  ["2026-11-12T0045Z", { skip: true, pad: "\n\n" }, skip], // padded: unreadable under the strict rule only
  ["2026-11-12T0100Z", bet("PENGU"), null], // no second answer
  ["2026-11-12T0115Z", bet("PENGU"), bet("PENGU"), "Another message."], // a second request that differs
  ["2026-11-12T0130Z", skip, skip, "same completion"], // the first completion served again, byte for byte
];

let runDir = "";
let cfg: RunConfig;

before(() => {
  runDir = tempDir();
  const pins = pinsFromFixtures(MODEL);
  cfg = makeConfig({
    models: [MODEL],
    rulebook: "proposed-A",
    ask_twice: true,
    pinned: { [MODEL]: { ...pins, ed25519: { ...pins.ed25519, signing_address: signer.publicHex } } },
  });
  writeFileSync(configPath(runDir), JSON.stringify(cfg));
  TICKS.forEach(([tick, first, second, note], i) => {
    const dir = exchangeDir(runDir, tick, MODEL, "INTERN");
    const nonce = i.toString(16).padStart(16, "0");
    writeSignedExchange(dir, cfg, { model: MODEL, tick, nonce, answer: first, signer });
    if (second === null) return;
    const served = note === "same completion";
    writeSignedExchange(join(dir, SECOND), cfg, {
      model: MODEL,
      tick,
      nonce,
      answer: second,
      signer,
      ...(served ? {} : { chatId: `second-${i}` }),
      ...(note && !served ? { userLine: note } : {}),
    });
  });
});

after(() => rmSync(runDir, { recursive: true, force: true }));

describe("how often the two answers disagree", () => {
  it("compares decisions and verdicts of the pairs, under the strict rule", () => {
    const a = buildAgreement(loadRun(runDir), { answerRule: "strict", scheme: "ed25519" });
    assert.deepEqual(a.rows, [
      {
        model: MODEL,
        rank: "INTERN",
        pairs: 5,
        decisionDiffers: 3, // PENGU then DOGE; skip then WIF; unreadable then skip
        verdictDiffers: 2,
        verdictChanges: { "SKIP → NOT_ON_LIST": 1, "MALFORMED_DECISION → SKIP": 1 },
        unpaired: 1,
        sameResponse: 1, // left out of the pairs: it would agree with itself
      },
    ]);
    assert.deepEqual(a.warnings, [
      "2026-11-12T0115Z z-ai/glm-5.3-flash INTERN: the second request is not the first one byte for byte",
    ]);
  });

  it("with blank lines ignored, the padded skip and the plain skip agree", () => {
    const [row] = buildAgreement(loadRun(runDir), { answerRule: "trim", scheme: "ed25519" }).rows;
    assert.equal(row?.decisionDiffers, 2);
    assert.equal(row?.verdictDiffers, 1);
    assert.deepEqual(row?.verdictChanges, { "SKIP → NOT_ON_LIST": 1 });
  });

  it("prints a table with the shares, and no path from this machine", () => {
    const text = formatAgreement(
      buildAgreement(loadRun(runDir), { answerRule: "strict", scheme: "ed25519" }),
    );
    for (const s of [
      "# Asked twice: shadow run test",
      `| \`${MODEL}\` | INTERN | 5 | 3 (60.0%) | 2 (40.0%) | MALFORMED_DECISION → SKIP 1, SKIP → NOT_ON_LIST 1 | 1 | 1 |`,
      "the second request is not the first one byte for byte",
    ]) {
      assert.ok(text.includes(s), `missing: ${s}`);
    }
    assert.ok(!text.includes(runDir));
  });

  it("refuses a run that did not ask twice", () => {
    const run = loadRun(runDir);
    const { ask_twice: _, ...once } = run.cfg;
    assert.throws(
      () => buildAgreement({ ...run, cfg: once }, { answerRule: "strict", scheme: "ed25519" }),
      /does not ask twice/,
    );
  });
});
