import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

// What Hyperliquid signs, byte for byte, as its official Python SDK builds it (test/vectors.json was made with it):
// - L1 actions (orders, leverage): msgpack(action) ‖ nonce ‖ vault flag, hashed, wrapped in a "phantom agent", EIP-712.
// - User-signed actions (approveAgent, usdSend): EIP-712 over the action's fields, domain HyperliquidSignTransaction.
// Works in the browser and in Node: no Buffer, no dependencies beyond @noble.

const te = new TextEncoder();

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error(`not hex: ${h}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const u64be = (n: number | bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};

// ---------------------------------------------------------------- msgpack, the subset Hyperliquid actions use

export type Packable = null | boolean | number | string | Packable[] | { [k: string]: Packable };

/** msgpack as Python's `msgpack.packb` writes it: smallest int forms, str8 for 32-255 bytes, keys in insertion order. */
export function msgpack(v: Packable): Uint8Array {
  const out: number[] = [];
  const be = (n: number | bigint, bytes: number) => {
    let x = BigInt(n);
    const b: number[] = [];
    for (let i = 0; i < bytes; i++) {
      b.unshift(Number(x & 0xffn));
      x >>= 8n;
    }
    out.push(...b);
  };
  const enc = (x: Packable): void => {
    if (x === null) out.push(0xc0);
    else if (typeof x === "boolean") out.push(x ? 0xc3 : 0xc2);
    else if (typeof x === "number") {
      if (!Number.isSafeInteger(x))
        throw new Error(`msgpack: only whole numbers are used in actions, got ${x}`);
      if (x >= 0) {
        if (x < 0x80) out.push(x);
        else if (x <= 0xff) out.push(0xcc, x);
        else if (x <= 0xffff) {
          out.push(0xcd);
          be(x, 2);
        } else if (x <= 0xffffffff) {
          out.push(0xce);
          be(x, 4);
        } else {
          out.push(0xcf);
          be(x, 8);
        }
      } else {
        if (x >= -32) out.push(0x100 + x);
        else if (x >= -0x80) out.push(0xd0, 0x100 + x);
        else if (x >= -0x8000) {
          out.push(0xd1);
          be(0x10000 + x, 2);
        } else if (x >= -0x80000000) {
          out.push(0xd2);
          be(0x100000000 + x, 4);
        } else {
          out.push(0xd3);
          be((1n << 64n) + BigInt(x), 8);
        }
      }
    } else if (typeof x === "string") {
      const b = te.encode(x);
      if (b.length < 32) out.push(0xa0 | b.length);
      else if (b.length <= 0xff) out.push(0xd9, b.length);
      else if (b.length <= 0xffff) {
        out.push(0xda);
        be(b.length, 2);
      } else {
        out.push(0xdb);
        be(b.length, 4);
      }
      out.push(...b);
    } else if (Array.isArray(x)) {
      if (x.length < 16) out.push(0x90 | x.length);
      else if (x.length <= 0xffff) {
        out.push(0xdc);
        be(x.length, 2);
      } else {
        out.push(0xdd);
        be(x.length, 4);
      }
      for (const e of x) enc(e);
    } else {
      const keys = Object.keys(x);
      if (keys.length < 16) out.push(0x80 | keys.length);
      else if (keys.length <= 0xffff) {
        out.push(0xde);
        be(keys.length, 2);
      } else {
        out.push(0xdf);
        be(keys.length, 4);
      }
      for (const k of keys) {
        enc(k);
        enc(x[k] as Packable);
      }
    }
  };
  enc(v);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- EIP-712 for the flat structs Hyperliquid uses

export interface Field {
  name: string;
  type: "string" | "address" | "uint64" | "uint256" | "bytes32";
}

function encodeField(type: Field["type"], v: unknown): Uint8Array {
  switch (type) {
    case "string":
      return keccak_256(te.encode(String(v)));
    case "address": {
      const a = fromHex(String(v));
      if (a.length !== 20) throw new Error(`not an address: ${String(v)}`);
      return concat(new Uint8Array(12), a);
    }
    case "uint64":
    case "uint256": {
      const b = new Uint8Array(32);
      let x = BigInt(v as number | string | bigint);
      for (let i = 31; i >= 0; i--) {
        b[i] = Number(x & 0xffn);
        x >>= 8n;
      }
      return b;
    }
    case "bytes32": {
      const b = v instanceof Uint8Array ? v : fromHex(String(v));
      if (b.length !== 32) throw new Error("bytes32 must be 32 bytes");
      return b;
    }
  }
}

function hashStruct(primary: string, fields: Field[], values: Record<string, unknown>): Uint8Array {
  const typeHash = keccak_256(te.encode(`${primary}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`));
  return keccak_256(concat(typeHash, ...fields.map((f) => encodeField(f.type, values[f.name]))));
}

const DOMAIN_FIELDS: Field[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function typedDataDigest(
  domain: { name: string; version: string; chainId: number },
  primary: string,
  fields: Field[],
  values: Record<string, unknown>,
): Uint8Array {
  const sep = hashStruct("EIP712Domain", DOMAIN_FIELDS, { ...domain, verifyingContract: ZERO_ADDRESS });
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), sep, hashStruct(primary, fields, values)));
}

// ---------------------------------------------------------------- the two kinds of Hyperliquid action

/** The chain id wallets sign user actions with (Hyperliquid accepts any; the SDK uses Arbitrum Sepolia's). */
export const SIGNATURE_CHAIN_ID = "0x66eee";

export const USER_TYPES = {
  "HyperliquidTransaction:ApproveAgent": [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
  "HyperliquidTransaction:UsdSend": [
    { name: "hyperliquidChain", type: "string" },
    { name: "destination", type: "string" },
    { name: "amount", type: "string" },
    { name: "time", type: "uint64" },
  ],
} as const satisfies Record<string, Field[]>;
export type UserPrimary = keyof typeof USER_TYPES;

/** The digest of a user-signed action (it carries its own signatureChainId and hyperliquidChain). */
export function userActionDigest(primary: UserPrimary, action: Record<string, unknown>): Uint8Array {
  const chainId = Number.parseInt(String(action.signatureChainId), 16);
  return typedDataDigest(
    { name: "HyperliquidSignTransaction", version: "1", chainId },
    primary,
    [...USER_TYPES[primary]],
    action,
  );
}

/** keccak(msgpack(action) ‖ nonce ‖ 0x00): no vault, no expiry. */
export function actionHash(action: Packable, nonce: number): Uint8Array {
  return keccak_256(concat(msgpack(action), u64be(nonce), Uint8Array.of(0)));
}

/** The digest an agent key signs for an L1 action (orders, leverage): the "phantom agent" of the SDK. */
export function l1Digest(action: Packable, nonce: number, testnet: boolean): Uint8Array {
  return typedDataDigest(
    { name: "Exchange", version: "1", chainId: 1337 },
    "Agent",
    [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
    { source: testnet ? "b" : "a", connectionId: actionHash(action, nonce) },
  );
}

// ---------------------------------------------------------------- keys and signatures

export interface Sig {
  r: string;
  s: string;
  v: number;
}

/** Signs a 32-byte digest (RFC 6979, low s, as eth_account does). */
export function signDigest(privateKey: Uint8Array, digest: Uint8Array): Sig {
  const rec = secp256k1.sign(digest, privateKey, { prehash: false, format: "recovered" });
  // noble's "recovered" format: recovery ‖ r ‖ s.
  return { r: toHex(rec.subarray(1, 33)), s: toHex(rec.subarray(33, 65)), v: 27 + (rec[0] ?? 0) };
}

export function addressOfPublicKey(uncompressed: Uint8Array): string {
  const xy = uncompressed.length === 65 ? uncompressed.subarray(1) : uncompressed;
  if (xy.length !== 64) throw new Error("expected a 64- or 65-byte uncompressed key");
  return toHex(keccak_256(xy).subarray(12));
}

export function addressOfPrivateKey(privateKey: Uint8Array): string {
  return addressOfPublicKey(secp256k1.getPublicKey(privateKey, false));
}

/** Who signed `digest`: the lower-case address, or null. */
export function recoverAddress(digest: Uint8Array, sig: Sig): string | null {
  try {
    // r and s may come without leading zeros (the SDK writes hex(int)): pad both to 32 bytes.
    const word = (h: string) => fromHex(h.replace(/^0x/, "").padStart(64, "0"));
    const rec = concat(Uint8Array.of(sig.v - 27), word(sig.r), word(sig.s));
    const pub = secp256k1.recoverPublicKey(rec, digest, { prehash: false });
    return addressOfPublicKey(secp256k1.Point.fromBytes(pub).toBytes(false));
  } catch {
    return null;
  }
}
