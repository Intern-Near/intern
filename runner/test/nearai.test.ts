import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkModels, checkSigner } from "../src/check.ts";
import { matchesRecorded, parseModelSigners, parseModels, SIGNED_CHAT_MODELS } from "../src/nearai.ts";

const CATALOG = new URL("../../fixtures/ai/catalog/2026-11-11T1451Z/", import.meta.url);
const DATA = new URL("./data/", import.meta.url);
const read = (base: URL, name: string): string => readFileSync(new URL(name, base), "utf8");

const QWEN_ECDSA = read(DATA, "attestation-qwen3.8-27b-ecdsa-trimmed.json");
const QWEN_NONCE = "036fb6b4bc4cb250b004862ad06d0c6b77cd60fe97840ebed802e3975953339a";
const GLM_ED25519 = read(DATA, "attestation-glm-5.3-flash-ed25519-trimmed.json");
const GLM_NONCE = "719ba0bc8167f6f9a6e859c32ec8faf06db99f4d37c8e1e8843728496d0e27e0";

describe("NEAR AI model list", () => {
  it("lists all four signed models, owned by nearai, in the real snapshot", () => {
    const models = parseModels(read(CATALOG, "models.json"));
    assert.equal(models.length, 63);
    const checks = checkModels(models);
    assert.deepEqual(
      checks.map((c) => c.model),
      [...SIGNED_CHAT_MODELS],
    );
    assert.deepEqual(
      checks.filter((c) => c.problems.length > 0),
      [],
    );
  });

  it("reports a model that is gone or not owned by nearai", () => {
    const models = parseModels(read(CATALOG, "models.json"))
      .filter((m) => m.id !== "z-ai/glm-5.3-flash")
      .map((m) => (m.id === "Qwen/Qwen3.8-27B" ? { ...m, owned_by: "someone-else" } : m));
    const bad = checkModels(models).filter((c) => c.problems.length > 0);
    assert.deepEqual(bad, [
      {
        model: "Qwen/Qwen3.8-27B",
        owned_by: "someone-else",
        problems: ['owned_by is "someone-else", not "nearai"; it may not be TEE-signed'],
      },
      { model: "z-ai/glm-5.3-flash", owned_by: null, problems: ["not listed by GET /v1/models"] },
    ]);
  });
});

describe("NEAR AI attestation report", () => {
  it("reads the ecdsa signer from a real report, and it matches the research value", () => {
    const signers = parseModelSigners(QWEN_ECDSA, {
      model: "Qwen/Qwen3.8-27B",
      algo: "ecdsa",
      nonce: QWEN_NONCE,
    });
    assert.deepEqual(signers, [
      {
        model_name: "Qwen/Qwen3.8-27B",
        signing_algo: "ecdsa",
        signing_address: "0x835ab53d20294ef795906dff21ae4c045336aa26",
      },
    ]);
    const c = checkSigner("Qwen/Qwen3.8-27B", "ecdsa", signers);
    assert.deepEqual(c.problems, []);
    assert.match(c.note, /^same as research/);
  });

  it("reads the ed25519 signer from a real report", () => {
    const signers = parseModelSigners(GLM_ED25519, {
      model: "z-ai/glm-5.3-flash",
      algo: "ed25519",
      nonce: GLM_NONCE,
    });
    assert.equal(
      signers[0]?.signing_address,
      "5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff",
    );
    assert.deepEqual(checkSigner("z-ai/glm-5.3-flash", "ed25519", signers).problems, []);
  });

  it("refuses a report that does not echo our nonce or names another model or scheme", () => {
    const expect = { model: "Qwen/Qwen3.8-27B", algo: "ecdsa" as const, nonce: QWEN_NONCE };
    assert.throws(() => parseModelSigners(QWEN_ECDSA, { ...expect, nonce: "00".repeat(32) }), /nonce/);
    assert.throws(
      () => parseModelSigners(QWEN_ECDSA, { ...expect, model: "z-ai/glm-5.3-flash" }),
      /for model/,
    );
    assert.throws(() => parseModelSigners(QWEN_ECDSA, { ...expect, algo: "ed25519" }), /uses ecdsa/);
  });

  it("refuses a malformed signing address", () => {
    const body = QWEN_ECDSA.replace("0x835ab53d20294ef795906dff21ae4c045336aa26", "0x835ab53d");
    assert.throws(
      () => parseModelSigners(body, { model: "Qwen/Qwen3.8-27B", algo: "ecdsa", nonce: QWEN_NONCE }),
      /malformed signing_address/,
    );
  });

  it("treats a missing model_attestations field as unsigned", () => {
    const signers = parseModelSigners('{"gateway_attestation":{}}', {
      model: "Qwen/Qwen3.8-27B",
      algo: "ecdsa",
      nonce: QWEN_NONCE,
    });
    assert.deepEqual(signers, []);
    assert.deepEqual(checkSigner("Qwen/Qwen3.8-27B", "ecdsa", signers).problems, [
      "no model attestation: answers would not be signed by the model's own hardware",
    ]);
  });

  it("reports two candidates, and a signer that changed since the research", () => {
    const a = {
      model_name: "Qwen/Qwen3.8-27B",
      signing_algo: "ecdsa" as const,
      signing_address: "0x1111111111111111111111111111111111111111",
    };
    const c = checkSigner("Qwen/Qwen3.8-27B", "ecdsa", [a, a]);
    assert.equal(c.problems.length, 2);
    assert.match(c.problems[0] ?? "", /2 candidates/);
    assert.match(c.problems[1] ?? "", /signer changed: research recorded 0x835AB53d/);
  });

  it("compares full and shortened recorded addresses", () => {
    assert.ok(
      matchesRecorded(
        "0x835AB53D20294EF795906DFF21AE4C045336AA26",
        "0x835AB53d20294Ef795906DFf21aE4C045336aa26",
      ),
    );
    assert.ok(matchesRecorded("0x3b753b4406613c5e70ae640508632b600424fa0c", "0x3b753b44…fa0c"));
    assert.ok(!matchesRecorded("0x3b753b4406613c5e70ae640508632b600424fa0d", "0x3b753b44…fa0c"));
    assert.ok(!matchesRecorded("0x3b753b4406613c5e70ae640508632b600424fa0c", "0x3b75…3b44…fa0c"));
  });
});
