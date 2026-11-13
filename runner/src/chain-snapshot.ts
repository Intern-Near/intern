import { isRecord } from "./json.ts";
import { RpcError, type RpcExchange, rpcCall, viewAt } from "./near-rpc.ts";
import type { Block, View } from "./quote.ts";

/**
 * Read-only NEAR access for `quote` and the MCP server: the latest final block, then every view of one answer at
 * that block (a `query` with `block_id`), so the numbers of one answer come from one state of the contract. Built on
 * near-rpc.ts (plain JSON-RPC over fetch, every reply keepable for tests). It only reads: `status`, `block` and
 * `query`; nothing here can sign or send.
 */

/**
 * The testnet RPC the read-only commands default to: the runner's own default (src/near.ts DEFAULT_TESTNET_RPC, the
 * `rpc` of interface/deployments.json), written again here so that `quote` and the MCP server never load near.ts,
 * the module that can sign. test/quote.test.ts checks that the two stay equal.
 */
export const READ_RPC = "https://test.rpc.fastnear.com";

export interface Snapshot {
  block: Block;
  view: View;
}

/** The RPC's chain id (`status`, docs.near.org/api/rpc/network; "testnet" on the testnet RPCs, seen 2026-11-13). */
export async function chainId(
  urls: readonly string[],
  fetchFn: typeof fetch,
  record?: (e: RpcExchange) => void,
): Promise<string> {
  const { result } = await rpcCall(urls, "status", {}, fetchFn, record);
  if (!isRecord(result) || typeof result.chain_id !== "string") throw new RpcError("status: no chain_id");
  return result.chain_id;
}

/**
 * The latest final block (`block` with `finality: "final"`) and a view function pinned to it. The block's time is
 * `header.timestamp_nanosec`, a decimal string (`header.timestamp` is the same number as JSON, too big to be exact).
 */
export async function finalSnapshot(
  urls: readonly string[],
  contract: string,
  fetchFn: typeof fetch,
  record?: (e: RpcExchange) => void,
): Promise<Snapshot> {
  const { result } = await rpcCall(urls, "block", { finality: "final" }, fetchFn, record);
  const header = isRecord(result) && isRecord(result.header) ? result.header : null;
  if (
    header === null ||
    typeof header.height !== "number" ||
    typeof header.hash !== "string" ||
    typeof header.timestamp_nanosec !== "string" ||
    !/^[0-9]+$/.test(header.timestamp_nanosec)
  ) {
    throw new RpcError("block: the reply has no height, hash and timestamp_nanosec");
  }
  const block: Block = {
    height: header.height,
    hash: header.hash,
    time_ms: Number(BigInt(header.timestamp_nanosec) / 1_000_000n),
  };
  return {
    block,
    view: async (method, args) =>
      (await viewAt(urls, contract, method, args, block.hash, fetchFn, record)).value,
  };
}
