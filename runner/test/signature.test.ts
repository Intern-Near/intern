import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  checkSignatureReply,
  eip191Hash,
  hexToBytes,
  recoverEthAddress,
  type SignatureReply,
  verifyEd25519,
} from "../src/signature.ts";

// The strong test of this file's code is in recordings.test.ts: NEAR AI's real signatures must recover to
// NEAR AI's published signers. These tests cover the edges with locally made keys.

const TEXT = "Qwen/Qwen3.8-27B:aa:bb";
const message = new TextEncoder().encode(TEXT);
const secretKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const address = `0x${Buffer.from(keccak_256(secp256k1.getPublicKey(secretKey, false).subarray(1)).subarray(12)).toString("hex")}`;

/** An Ethereum-style r ‖ s ‖ v signature over the EIP-191 hash of `msg`. */
function ethSign(msg: Uint8Array, vBase: 0 | 27): Uint8Array {
  const rec = secp256k1.sign(eip191Hash(msg), secretKey, { prehash: false, format: "recovered" }); // rec ‖ r ‖ s
  const out = new Uint8Array(65);
  out.set(rec.subarray(1), 0);
  out[64] = (rec[0] ?? 0) + vBase;
  return out;
}

describe("signature checks", () => {
  it("recovers the signer from r ‖ s ‖ v, with v as 27/28 or 0/1", () => {
    assert.equal(recoverEthAddress(eip191Hash(message), ethSign(message, 27)), address);
    assert.equal(recoverEthAddress(eip191Hash(message), ethSign(message, 0)), address);
  });

  it("recovers another address when the text changes, and throws on a bad v", () => {
    const sig = ethSign(message, 27);
    assert.notEqual(recoverEthAddress(eip191Hash(new TextEncoder().encode(`${TEXT}x`)), sig), address);
    const badV = Uint8Array.from(sig);
    badV[64] = 29;
    assert.throws(() => recoverEthAddress(eip191Hash(message), badV), /v value/);
  });

  it("verifies ed25519 with a raw 32-byte key, and rejects a changed message or key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
    const sig = sign(null, message, privateKey);
    assert.ok(verifyEd25519(message, sig, raw));
    assert.ok(!verifyEd25519(new TextEncoder().encode(`${TEXT}x`), sig, raw));
    assert.ok(!verifyEd25519(message, sig, Uint8Array.from(raw).fill(7, 0, 1)));
    assert.ok(!verifyEd25519(message, sig.subarray(1), raw));
  });

  it("reads hex with or without 0x, only at the exact length", () => {
    assert.deepEqual(hexToBytes("0x0aFF", 2), Uint8Array.from([10, 255]));
    assert.deepEqual(hexToBytes("0aff", 2), Uint8Array.from([10, 255]));
    assert.equal(hexToBytes("0aff", 3), null);
    assert.equal(hexToBytes("0agg", 2), null);
  });

  it("checks a reply the way NEAR AI's reference helper does", () => {
    const reply: SignatureReply = {
      text: TEXT,
      signature: `0x${Buffer.from(ethSign(message, 27)).toString("hex")}`,
      signing_address: address,
      signing_algo: "ecdsa",
      signature_kind: "provider_tee",
    };
    const expected = { algo: "ecdsa" as const, text: TEXT, preflightSigner: address };
    assert.deepEqual(checkSignatureReply(reply, expected), []);
    assert.deepEqual(checkSignatureReply({ ...reply, text: `${TEXT}x` }, { ...expected, text: `${TEXT}x` }), [
      `signature recovers ${recoverEthAddress(eip191Hash(new TextEncoder().encode(`${TEXT}x`)), ethSign(message, 27))}, not signing_address`,
    ]);
    assert.deepEqual(checkSignatureReply(reply, { ...expected, text: "other" }), [
      "signed text does not match the exact request and response bytes",
    ]);
    assert.deepEqual(checkSignatureReply({ ...reply, signature_kind: "gateway" }, expected), [
      "signature_kind is gateway, not provider_tee",
    ]);
    assert.deepEqual(checkSignatureReply(reply, { ...expected, preflightSigner: `0x${"11".repeat(20)}` }), [
      "signer differs from the preflight attestation report",
    ]);
  });
});
