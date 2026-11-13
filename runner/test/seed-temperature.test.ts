import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readDecisionLine } from "../src/decision.ts";
import { answerText } from "../src/judge.ts";
import { PINNED_01 } from "../src/pinned.ts";
import { SEED_NONCE, SEED_ROUND, seedRequest } from "../src/seed-temperature.ts";
import {
  checkSignatureReply,
  parseSignatureReply,
  signedText,
  verifyModelSignature,
} from "../src/signature.ts";
import { requestShapeProblems } from "../src/verify-round.ts";

// The research of runner/docs/seed-and-temperature.md: real exchanges with z-ai/glm-5.3-flash on 2026-11-13 between
// 13:51 and 13:58 UTC, saved by src/cli/seed-temperature.ts in fixtures/ai/seed-temperature/. Offline.
const AT = new URL("../../fixtures/ai/seed-temperature/", import.meta.url);
const file = (path: string): Buffer => readFileSync(new URL(path, AT));
const FIRST = "20261113T135120Z/01-t0-seed42/";
const T0_SEED42 = [FIRST, "20261113T135220Z/01-t0-seed42/", "20261113T135220Z/02-t0-seed42/"];

describe("seed and temperature research", () => {
  it("rebuilds the exact request bytes that were sent", () => {
    for (const dir of T0_SEED42) assert.ok(seedRequest("t0-seed42").equals(file(`${dir}request.bin`)), dir);
    assert.ok(
      seedRequest("t0-seed42").toString("utf8").endsWith(',"stream":false,"temperature":0,"seed":42}'),
    );
  });

  it("NEAR AI's signature covers the request bytes with temperature and seed in them", () => {
    const request = file(`${FIRST}request.bin`);
    const response = file(`${FIRST}response.bin`);
    const text = signedText(PINNED_01.model, request, response);
    const reply = parseSignatureReply(file(`${FIRST}signature-ed25519.json`).toString("utf8"));
    assert.deepEqual(
      checkSignatureReply(reply, { algo: "ed25519", text, preflightSigner: PINNED_01.signer }),
      [],
    );
    assert.equal(reply.signature_kind, "provider_tee");
    // The same bytes with another seed, or with no temperature and seed: the signature no longer verifies.
    const signature = Buffer.from(reply.signature, "hex");
    const otherSeed = Buffer.from(request.toString("utf8").replace('"seed":42', '"seed":43'));
    assert.equal(
      verifyModelSignature(
        "ed25519",
        PINNED_01.signer,
        signedText(PINNED_01.model, otherSeed, response),
        signature,
      ),
      false,
    );
    const without = Buffer.from(request.toString("utf8").replace(',"temperature":0,"seed":42', ""));
    assert.equal(
      verifyModelSignature(
        "ed25519",
        PINNED_01.signer,
        signedText(PINNED_01.model, without, response),
        signature,
      ),
      false,
    );
  });

  it("three answers to the same bytes at temperature 0 and seed 42 did not all agree", () => {
    const margins = T0_SEED42.map((dir) => {
      const answer = answerText(file(`${dir}response.bin`));
      const read = readDecisionLine(answer ?? "", { round_id: SEED_ROUND, nonce: SEED_NONCE });
      assert.ok(read.ok && read.decision.action === "BET", dir);
      return read.decision.action === "BET" ? `${read.decision.market} ${read.decision.margin_e6}` : "";
    });
    assert.deepEqual(margins, ["PENGU 11000000", "PENGU 11000000", "PENGU 20000000"]);
  });

  it("the contract would refuse such a request today: 01 §6.3 allows no temperature or seed", () => {
    assert.deepEqual(requestShapeProblems(seedRequest("t0-seed42"), PINNED_01.model, null), [
      "keys 01 §6.3 does not allow: temperature, seed",
    ]);
  });

  it("an invalid seed or temperature is refused by name, so both fields are read", () => {
    const status = (dir: string): number => JSON.parse(file(`${dir}exchange.json`).toString("utf8")).status;
    assert.equal(status("20261113T135824Z/01-bad-temperature/"), 400);
    assert.match(
      file("20261113T135824Z/01-bad-temperature/response.bin").toString("utf8"),
      /temperature must be between 0 and 2/,
    );
    assert.equal(status("20261113T135824Z/02-bad-seed/"), 400);
    assert.match(
      file("20261113T135824Z/02-bad-seed/response.bin").toString("utf8"),
      /Input should be a valid integer/,
    );
  });
});
