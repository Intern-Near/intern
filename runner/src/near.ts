import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  Account,
  baseDecode,
  getTransactionLastResult,
  JsonRpcProvider,
  KeyPairSigner,
  teraToGas,
} from "near-api-js";
import type { Secret } from "./secret.ts";

/**
 * NEAR access for the runner, over near-api-js 7.4.0. Views are free and need no key. Calls are signed by one of
 * two accounts, kept apart on purpose (03-ENGINE-2 brief §3, with 01 1.1's change to `sign_next`):
 * - the runner: a function-call key limited to the contract's `propose`, `sign_next` and `report_result`; it
 *   cannot move money, and it cannot attach a deposit (01 1.1: `sign_next` needs none);
 * - the relayer: a separate account holding a little testnet NEAR, for `close`, which needs 1 yocto attached, and
 *   for `settle`. It has no special rights in the contract.
 */

/** Testnet RPC used by the research (VERIFIED there); overridable with NEAR_RPC_URL. */
export const DEFAULT_TESTNET_RPC = "https://test.rpc.fastnear.com";

export function provider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider({ url: rpcUrl });
}

/** A read-only view call. Returns the parsed JSON result. */
export async function view(
  rpc: JsonRpcProvider,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await rpc.callFunction({ contractId, method, args });
  } catch (e) {
    throw new Error(`${contractId} ${method}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

export interface CallResult {
  txHash: string;
  /** The function's return value, parsed from JSON; undefined when it returned nothing. */
  value: unknown;
  /** Gas burnt by the transaction and every receipt it caused, in TGas (the research scripts' sum). */
  tgas: number | null;
}

/**
 * Gas burnt by a transaction and all its receipts, in TGas: `transaction_outcome.outcome.gas_burnt` plus each
 * `receipts_outcome[].outcome.gas_burnt` (as `research-scripts/hl_guard_e2e.mjs` measured it). Null if the
 * outcome does not have that shape.
 */
export function burntTeraGas(outcome: unknown): number | null {
  const o = outcome as {
    transaction_outcome?: { outcome?: { gas_burnt?: unknown } };
    receipts_outcome?: { outcome?: { gas_burnt?: unknown } }[];
  };
  const first = o?.transaction_outcome?.outcome?.gas_burnt;
  if (first === undefined || !Array.isArray(o.receipts_outcome)) return null;
  let total = 0n;
  for (const g of [first, ...o.receipts_outcome.map((r) => r?.outcome?.gas_burnt)]) {
    if (typeof g !== "number" && typeof g !== "bigint" && typeof g !== "string") return null;
    total += BigInt(g);
  }
  return Number(total / 10_000_000_000n) / 100; // TGas with two decimals
}

/** A signed function call. Throws with the transaction hash if the call fails on chain. */
export async function call(
  account: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  opts: { teraGas: number; yoctoDeposit?: bigint },
): Promise<CallResult> {
  let outcome: Awaited<ReturnType<Account["callFunctionRaw"]>>;
  try {
    // near-api-js waits until every receipt has run (EXECUTED_OPTIMISTIC) and throws if the call failed on chain.
    // It re-sends by itself only when NEAR refused the transaction's nonce, i.e. before anything ran.
    outcome = await account.callFunctionRaw({
      contractId,
      methodName,
      args,
      gas: teraToGas(opts.teraGas),
      deposit: opts.yoctoDeposit ?? 0n,
    });
  } catch (e) {
    throw new Error(`${methodName} failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600), {
      cause: e,
    });
  }
  const txHash = outcome.transaction.hash;
  const status = outcome.status as unknown as Record<string, unknown>;
  if (status && typeof status === "object" && "Failure" in status) {
    throw new Error(
      `${methodName} failed on chain (tx ${txHash}): ${JSON.stringify(status.Failure).slice(0, 300)}`,
    );
  }
  return { txHash, value: getTransactionLastResult(outcome), tgas: burntTeraGas(outcome) };
}

/** An account that signs with a key from the environment. The key never leaves the Secret except here. */
export function signingAccount(accountId: string, privateKey: Secret, rpc: JsonRpcProvider): Account {
  return new Account(accountId, rpc, KeyPairSigner.fromSecretKey(privateKey.reveal() as `ed25519:${string}`));
}

/**
 * The Ethereum-style address of a public key returned by NEAR's signing network (`derived_public_key`, given as
 * "secp256k1:<base58 of the 64-byte uncompressed key>"). Used to check the contract's Hyperliquid address.
 */
export function addressFromDerivedKey(derived: string): string {
  const [curve, body] = derived.split(":");
  if (curve !== "secp256k1" || body === undefined) throw new Error(`not a secp256k1 key: ${derived}`);
  const raw = baseDecode(body);
  if (raw.length !== 64) throw new Error("expected a 64-byte uncompressed key");
  const full = new Uint8Array(65);
  full[0] = 0x04;
  full.set(raw, 1);
  secp256k1.Point.fromBytes(full); // throws if the point is not on the curve
  return `0x${Buffer.from(keccak_256(raw).subarray(12)).toString("hex")}`;
}
