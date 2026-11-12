import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { addressFromDerivedKey, burntTeraGas } from "../src/near.ts";

describe("gas burnt by a call", () => {
  it("adds the transaction and every receipt, in TGas", () => {
    const outcome = {
      transaction_outcome: { outcome: { gas_burnt: 2_428_000_000_000 } },
      receipts_outcome: [
        { outcome: { gas_burnt: 4_550_000_000_000 } },
        { outcome: { gas_burnt: 223_182_562_500 } },
      ],
    };
    assert.equal(burntTeraGas(outcome), 7.2);
  });
  it("is null when the outcome has another shape", () => {
    assert.equal(burntTeraGas({}), null);
    assert.equal(burntTeraGas({ transaction_outcome: { outcome: { gas_burnt: 1 } } }), null);
  });
});

describe("the Hyperliquid address of a contract", () => {
  it("is the address of the key NEAR's signing network derives for it (real view, saved)", () => {
    const d = JSON.parse(
      readFileSync(fileURLToPath(new URL("./data/derived-public-key-probe.json", import.meta.url)), "utf8"),
    );
    assert.equal(addressFromDerivedKey(d.result), "0x283779ffb96dc9ac3a03333e39b18ed0a793e040");
    assert.throws(() => addressFromDerivedKey("ed25519:abc"), /not a secp256k1 key/);
  });
});
