import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  actionHash,
  addressOfPrivateKey,
  fromHex,
  l1Digest,
  msgpack,
  type Packable,
  recoverAddress,
  signDigest,
  toHex,
  type UserPrimary,
  userActionDigest,
} from "../src/hash.ts";

// Every digest and signature below was made by Hyperliquid's official Python SDK (reference/sdk_vectors.py) or,
// for the order probes, by the earlier hl-order cross-check (fixtures/hl/reference/digests.json).

interface Vector {
  id: string;
  kind: "user" | "l1";
  primary?: UserPrimary;
  action: Record<string, Packable>;
  nonce?: number;
  action_hash?: string;
  digest: string;
  signer: string;
  signature: { r: string; s: string; v: number };
}
const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as {
  keys_are_test_only: Record<string, string>;
  cases: Vector[];
};
const KEY: Record<string, string> = {
  "approve-agent": V.keys_are_test_only.user ?? "",
  "usd-send": V.keys_are_test_only.faucet ?? "",
};
const keyFor = (v: Vector) =>
  fromHex(v.kind === "l1" ? (V.keys_are_test_only.agent ?? "") : (KEY[v.id.replace(/-\d+$/, "")] ?? ""));
const PROBES = JSON.parse(
  readFileSync(new URL("../../fixtures/hl/reference/digests.json", import.meta.url), "utf8"),
) as {
  cases: {
    id: string;
    action_json: string;
    msgpack_hex: string;
    nonce: number;
    expires_after: number | null;
    testnet: boolean;
    digest: string;
  }[];
};

describe("Hyperliquid's own digests", () => {
  for (const v of V.cases) {
    it(`${v.id}: the digest, and a signature identical to the SDK's`, () => {
      const d =
        v.kind === "user"
          ? userActionDigest(v.primary as UserPrimary, v.action)
          : l1Digest(v.action, v.nonce ?? 0, true);
      if (v.kind === "l1") assert.equal(toHex(actionHash(v.action, v.nonce ?? 0)), v.action_hash);
      assert.equal(toHex(d), v.digest);
      const key = keyFor(v);
      assert.equal(addressOfPrivateKey(key), v.signer.toLowerCase());
      const sig = signDigest(key, d);
      const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
      assert.equal(pad(sig.r), pad(v.signature.r));
      assert.equal(pad(sig.s), pad(v.signature.s));
      assert.equal(sig.v, v.signature.v);
      assert.equal(recoverAddress(d, v.signature), v.signer.toLowerCase());
    });
  }

  it("msgpack and digests of the probes the contract's own hl-order was checked against", () => {
    let n = 0;
    for (const p of PROBES.cases) {
      if (p.expires_after !== null || !p.testnet) continue; // tailfade sends no expiry; testnet only
      const action = JSON.parse(p.action_json) as Packable;
      assert.equal(toHex(msgpack(action)).slice(2), p.msgpack_hex, p.id);
      assert.equal(toHex(l1Digest(action, p.nonce, true)), p.digest, p.id);
      n++;
    }
    assert.ok(n >= 3, `checked ${n} probe cases`);
  });
});

describe("msgpack", () => {
  it("uses the smallest forms, like Python's msgpack", () => {
    assert.equal(toHex(msgpack(173)), "0xccad");
    assert.equal(toHex(msgpack(5)), "0x05");
    assert.equal(toHex(msgpack(70_000)), "0xce00011170");
    assert.equal(toHex(msgpack(-1)), "0xff");
    assert.equal(toHex(msgpack(true)), "0xc3");
    assert.equal(toHex(msgpack(null)), "0xc0");
    assert.equal(toHex(msgpack("a".repeat(40))).slice(0, 6), "0xd928");
    assert.throws(() => msgpack(0.5), /whole numbers/);
  });
});
