import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { isRecord } from "./json.ts";
import type { SigningAlgo } from "./nearai.ts";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The text NEAR AI signs for a `provider_tee` signature: `model:sha256(request):sha256(response)`. */
export function signedText(model: string, request: Uint8Array, response: Uint8Array): string {
  return `${model}:${sha256Hex(request)}:${sha256Hex(response)}`;
}

/** The Ethereum "personal sign" (EIP-191) hash: keccak256("\x19Ethereum Signed Message:\n" + length + message). */
export function eip191Hash(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const all = new Uint8Array(prefix.length + message.length);
  all.set(prefix);
  all.set(message, prefix.length);
  return keccak_256(all);
}

/**
 * Recovers the Ethereum address (0x + 40 lower-case hex) that produced a 65-byte r ‖ s ‖ v signature over a
 * 32-byte hash. `v` may be 27/28 or 0/1. Throws on a malformed signature.
 */
export function recoverEthAddress(hash: Uint8Array, sig65: Uint8Array): string {
  if (hash.length !== 32) throw new Error("hash must be 32 bytes");
  if (sig65.length !== 65) throw new Error("ecdsa signature must be 65 bytes");
  const v = sig65[64] ?? 0;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error(`unexpected v value ${v}`);
  // noble's "recovered" format puts the recovery byte first: recovery ‖ r ‖ s.
  const recovered = new Uint8Array(65);
  recovered[0] = recovery;
  recovered.set(sig65.subarray(0, 64), 1);
  const publicKey = secp256k1.recoverPublicKey(recovered, hash, { prehash: false });
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false); // 0x04 ‖ X ‖ Y
  return `0x${Buffer.from(keccak_256(uncompressed.subarray(1)).subarray(12)).toString("hex")}`;
}

/** Ed25519 check of a 64-byte signature over `message` with a raw 32-byte public key, using Node's own crypto. */
export function verifyEd25519(message: Uint8Array, sig64: Uint8Array, publicKey: Uint8Array): boolean {
  if (sig64.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
      format: "jwk",
    });
    return nodeVerify(null, message, key, sig64);
  } catch {
    return false; // a key Node cannot load is not a match
  }
}

/**
 * Check 3 as the contract does it: the raw signature bytes over `text`, against the pinned signer. Nothing from
 * NEAR AI's signature reply is trusted here; a proposal carries only the request, the response and the signature.
 * `signer` is the pinned identity as hex: a 20-byte address for ecdsa, a 32-byte public key for ed25519.
 */
export function verifyModelSignature(
  algo: SigningAlgo,
  signer: string,
  text: string,
  signature: Uint8Array,
): boolean {
  const message = new TextEncoder().encode(text);
  if (algo === "ed25519") {
    const key = hexToBytes(signer, 32);
    return key !== null && verifyEd25519(message, signature, key);
  }
  const address = hexToBytes(signer, 20);
  if (address === null || signature.length !== 65) return false;
  try {
    return recoverEthAddress(eip191Hash(message), signature) === `0x${Buffer.from(address).toString("hex")}`;
  } catch {
    return false;
  }
}

/** Hex (with or without 0x) to bytes of an exact length, or null. */
export function hexToBytes(value: string, length: number): Uint8Array | null {
  const hex = value.replace(/^0x/i, "");
  if (hex.length !== length * 2 || !/^[0-9a-f]*$/i.test(hex)) return null;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** The reply of GET /v1/signature/<chat id>. */
export interface SignatureReply {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind: string | null;
}

/**
 * Parses a signature reply. Throws when it is not a signature: an error body, or a 2xx body carrying
 * `error_code` and `message`, which NEAR AI's docs define as "an unavailable result, not a signature".
 */
export function parseSignatureReply(body: string): SignatureReply {
  const data: unknown = JSON.parse(body);
  if (!isRecord(data)) throw new Error("signature reply: not a JSON object");
  if ("error_code" in data || "error" in data)
    throw new Error(`signature unavailable: ${body.slice(0, 200)}`);
  const { text, signature, signing_address, signing_algo, signature_kind } = data;
  if (
    typeof text !== "string" ||
    typeof signature !== "string" ||
    typeof signing_address !== "string" ||
    typeof signing_algo !== "string"
  ) {
    throw new Error("signature reply: missing text, signature, signing_address or signing_algo");
  }
  return {
    text,
    signature,
    signing_address,
    signing_algo,
    signature_kind: typeof signature_kind === "string" ? signature_kind : null,
  };
}

/**
 * Checks one signature reply for a model-signed (`provider_tee`) answer, the way NEAR AI's reference helper does
 * (docs.near.ai/cloud/verification/reference/response-signature-verification.md): the signed text equals the
 * text rebuilt from the exact bytes, the signature is valid for `signing_address`, and that signer equals the
 * one from the preflight attestation report. Returns the problems found; an empty list means verified.
 */
export function checkSignatureReply(
  reply: SignatureReply,
  expected: { algo: SigningAlgo; text: string; preflightSigner: string },
): string[] {
  const problems: string[] = [];
  if (reply.signing_algo !== expected.algo) problems.push(`signing_algo is ${reply.signing_algo}`);
  if (reply.signature_kind !== "provider_tee") {
    problems.push(`signature_kind is ${reply.signature_kind ?? "absent"}, not provider_tee`);
  }
  if (reply.text !== expected.text)
    problems.push("signed text does not match the exact request and response bytes");

  const addressBytes = expected.algo === "ecdsa" ? 20 : 32;
  const address = hexToBytes(reply.signing_address, addressBytes);
  const signature = hexToBytes(reply.signature, expected.algo === "ecdsa" ? 65 : 64);
  if (address === null) problems.push("signing_address is not valid hex of the right length");
  if (signature === null) problems.push("signature is not valid hex of the right length");
  if (address !== null && signature !== null) {
    const message = new TextEncoder().encode(reply.text);
    if (expected.algo === "ecdsa") {
      let recovered = "";
      try {
        recovered = recoverEthAddress(eip191Hash(message), signature);
      } catch (e) {
        problems.push(`signature does not recover: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (recovered !== "" && recovered !== `0x${Buffer.from(address).toString("hex")}`) {
        problems.push(`signature recovers ${recovered}, not signing_address`);
      }
    } else if (!verifyEd25519(message, signature, address)) {
      problems.push("ed25519 signature does not verify for signing_address");
    }
  }
  const preflight = hexToBytes(expected.preflightSigner, addressBytes);
  if (address === null || preflight === null || !Buffer.from(address).equals(Buffer.from(preflight))) {
    problems.push("signer differs from the preflight attestation report");
  }
  return problems;
}
