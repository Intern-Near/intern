import { addressOfPublicKey, fromHex, type Sig, toHex } from "./hash.ts";

// A visitor's own Hyperliquid address comes from NEAR's signing network (chain signatures), derived for their NEAR
// account and a fixed path. Only that account can ask the network to sign for it: no contract of ours is in the path.
// Verified on testnet in RESEARCH-tail-or-fade.md §2e: Hyperliquid recovered the derived address from MPC signatures.

export const SIGNER = "v1.signer-prod.testnet";
/** The derivation path: one Tail or Fade address per NEAR account. Changing it changes every visitor's address. */
export const PATH = "tailfade-1";
export const DEFAULT_RPC = "https://test.rpc.fastnear.com";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** "secp256k1:<base58 of the 64-byte uncompressed key>" → the Ethereum-style address Hyperliquid uses. */
export function addressFromDerivedKey(derived: string): string {
  const [curve, body] = derived.split(":");
  if (curve !== "secp256k1" || !body) throw new Error(`not a secp256k1 key: ${derived}`);
  const raw = base58(body);
  if (raw.length !== 64) throw new Error("expected a 64-byte uncompressed key");
  return addressOfPublicKey(raw);
}

/** A read-only NEAR view call over JSON-RPC (works in the browser). */
export async function viewFunction(
  method: string,
  args: Record<string, unknown>,
  contract = SIGNER,
  rpc = DEFAULT_RPC,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchFn(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
  if (!body.result?.result) throw new Error(`${contract}.${method}: ${JSON.stringify(body.error ?? body)}`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result)));
}

/** The visitor's Hyperliquid address. */
export async function hlAddressOf(
  accountId: string,
  rpc = DEFAULT_RPC,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const key = await viewFunction(
    "derived_public_key",
    { path: PATH, predecessor: accountId, domain_id: 0 },
    SIGNER,
    rpc,
    fetchFn,
  );
  return addressFromDerivedKey(String(key));
}

/**
 * The one transaction the visitor's wallet signs: a call to the signing network's `sign` for a 32-byte digest.
 * NEAR's signing network asks for a 1 yocto deposit, so this cannot be done with a function-call key (a popup).
 * Shaped for @hot-labs/near-connect's signAndSendTransaction.
 */
export function signTransaction(digest: Uint8Array): {
  receiverId: string;
  actions: {
    type: "FunctionCall";
    params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
  }[];
} {
  if (digest.length !== 32) throw new Error("the digest must be 32 bytes");
  return {
    receiverId: SIGNER,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "sign",
          args: { request: { path: PATH, domain_id: 0, payload_v2: { Ecdsa: toHex(digest).slice(2) } } },
          gas: "300000000000000",
          deposit: "1",
        },
      },
    ],
  };
}

/** The signing network's answer ({ big_r, s, recovery_id }) as an Ethereum signature Hyperliquid reads. */
export function sigFromSignResult(v: unknown): Sig {
  const o = v as { big_r?: { affine_point?: string }; s?: { scalar?: string }; recovery_id?: number };
  const point = o.big_r?.affine_point;
  const scalar = o.s?.scalar;
  if (typeof point !== "string" || typeof scalar !== "string" || (o.recovery_id !== 0 && o.recovery_id !== 1))
    throw new Error(`not a signing-network signature: ${JSON.stringify(v)}`);
  // big_r is a compressed point (02/03 ‖ x); r is its x.
  if (fromHex(point).length !== 33) throw new Error("big_r must be a 33-byte compressed point");
  return { r: `0x${point.slice(2)}`, s: `0x${scalar}`, v: 27 + o.recovery_id };
}

/** From a wallet's transaction outcome (FinalExecutionOutcome) to the signature. */
export function sigFromOutcome(outcome: unknown): Sig {
  const status = (outcome as { status?: { SuccessValue?: string } }).status;
  if (typeof status?.SuccessValue !== "string")
    throw new Error(`the sign call did not succeed: ${JSON.stringify(status)}`);
  return sigFromSignResult(JSON.parse(atob(status.SuccessValue)));
}
