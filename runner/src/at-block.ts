import { isRecord } from "./json.ts";
import { RpcError, type RpcExchange, rpcCall, viewAt } from "./near-rpc.ts";

/**
 * Every view of one `books-check` or `supply-log` run is read at one final block, named by its hash, so the numbers
 * belong together: the coin's books, the token's balances and the lender's books all at the same moment, and every
 * page of the feed from the same state. Views read one after another at "final" could straddle a payment.
 *
 * Read-only: `status`, `block` and `query` (call_function) on NEAR's JSON-RPC (docs.near.org/api/rpc), through
 * src/near-rpc.ts, which hands every raw reply to `record` (for --save and the tests).
 */

export interface Block {
  height: number;
  hash: string;
  /** The block's time in ms since 1970, from `header.timestamp_nanosec`. */
  at_ms: number;
}

export interface AtBlock {
  readonly rpc: string;
  readonly block: Block;
  /** A read-only view at the block. Returns the parsed JSON value; a view that fails throws. */
  view(contract: string, method: string, args?: Record<string, unknown>): Promise<unknown>;
}

/**
 * The block's time. `header.timestamp` is in nanoseconds and too big for a JSON number to keep exactly (seen
 * 2026-11-13: 1794581902409805793), so the string `timestamp_nanosec` is read instead.
 */
function blockMs(header: Record<string, unknown>): number {
  const ns = header.timestamp_nanosec;
  if (typeof ns !== "string" || !/^[0-9]+$/.test(ns))
    throw new RpcError("block: no header.timestamp_nanosec");
  return Number(BigInt(ns) / 1_000_000n);
}

/** Checks that `rpc` serves NEAR testnet, then pins its latest final block. */
export async function atFinalBlock(
  rpc: string,
  fetchFn: typeof fetch,
  record?: (e: RpcExchange) => void,
): Promise<AtBlock> {
  const urls = [rpc];
  const status = await rpcCall(urls, "status", {}, fetchFn, record);
  const chain = isRecord(status.result) ? status.result.chain_id : undefined;
  if (chain !== "testnet")
    throw new RpcError(`${rpc} serves ${String(chain)}, not testnet: this check reads testnet only`);
  const b = await rpcCall(urls, "block", { finality: "final" }, fetchFn, record);
  const header = isRecord(b.result) && isRecord(b.result.header) ? b.result.header : null;
  if (
    header === null ||
    typeof header.height !== "number" ||
    !Number.isSafeInteger(header.height) ||
    typeof header.hash !== "string"
  )
    throw new RpcError("block: the reply has no header with a height and a hash");
  const block: Block = { height: header.height, hash: header.hash, at_ms: blockMs(header) };
  return {
    rpc,
    block,
    view: async (contract, method, args = {}) =>
      (await viewAt(urls, contract, method, args, block.hash, fetchFn, record)).value,
  };
}
