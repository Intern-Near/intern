import { isRecord } from "./json.ts";

/**
 * A small read-only JSON-RPC client for NEAR (docs.near.org/api/rpc), used by `verify-round` so that every reply
 * can be kept byte for byte and replayed in tests. It only reads: `tx`, `block` and `query` (views).
 *
 * A regular RPC node keeps about 36 hours of history (docs.near.org/integrations/nodes: 5 epochs); for anything
 * older it answers that it does not know the transaction or the block. Each call is therefore tried on the URLs in
 * order, moving on only when a node says it does not have the data.
 */

/** Public testnet archival endpoints, both answered for a transaction of 2026-11-11 when checked on 2026-11-13. */
export const TESTNET_ARCHIVAL_RPCS = [
  "https://archival-rpc.testnet.fastnear.com",
  "https://archival-rpc.testnet.near.org",
] as const;

/**
 * Error names a node gives when it does not hold the data (seen on 2026-11-13: `UNKNOWN_TRANSACTION` from `tx` with
 * `wait_until: "NONE"`, `UNKNOWN_BLOCK` from `block` and `query`; `TIMEOUT_ERROR` is what `tx` gives when it waits).
 * `GARBAGE_COLLECTED_BLOCK` is the name in nearcore's RPC errors for state that was dropped (UNVERIFIED: not seen).
 */
const NOT_HERE = new Set([
  "UNKNOWN_TRANSACTION",
  "UNKNOWN_BLOCK",
  "GARBAGE_COLLECTED_BLOCK",
  "TIMEOUT_ERROR",
]);

/** One request and the raw reply, as kept by `--save` and replayed by the tests. */
export interface RpcExchange {
  url: string;
  request: { jsonrpc: "2.0"; id: string; method: string; params: Record<string, unknown> };
  status: number;
  body: string;
  fetched_at: string;
}

export interface RpcAnswer {
  url: string;
  result: unknown;
}

export class RpcError extends Error {}

/**
 * Calls `method` on each URL in turn until one answers with a result. A reply saying the node does not have the
 * data, or a failed connection, moves on to the next URL; any other error stops and throws.
 */
export async function rpcCall(
  urls: readonly string[],
  method: string,
  params: Record<string, unknown>,
  fetchFn: typeof fetch,
  record?: (e: RpcExchange) => void,
): Promise<RpcAnswer> {
  const misses: string[] = [];
  for (const url of urls) {
    const request = { jsonrpc: "2.0" as const, id: "verify-round", method, params };
    let status: number;
    let body: string;
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(60_000),
      });
      status = res.status;
      body = await res.text();
    } catch (e) {
      misses.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    record?.({ url, request, status, body, fetched_at: new Date().toISOString() });
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      misses.push(`${url}: HTTP ${status}, not JSON`);
      continue;
    }
    if (isRecord(data) && isRecord(data.result)) {
      const result = data.result;
      // A view that fails can come back as a result holding an `error` text (tools/view.py reads it the same way).
      if (typeof result.error === "string") {
        throw new RpcError(`${method} on ${url}: ${result.error.slice(0, 300)}`);
      }
      return { url, result };
    }
    const error = isRecord(data) && isRecord(data.error) ? data.error : null;
    const name =
      error && isRecord(error.cause) && typeof error.cause.name === "string" ? error.cause.name : null;
    const message = error
      ? `${name ?? error.name ?? "error"}: ${String(error.data ?? error.message ?? "")}`
      : body;
    if (name !== null && NOT_HERE.has(name)) {
      misses.push(`${url}: ${name}`);
      continue;
    }
    throw new RpcError(`${method} on ${url}: ${message.slice(0, 300)}`);
  }
  throw new RpcError(`${method}: no node had it (${misses.join("; ")})`);
}

/** A read-only view at one block (`query` / `call_function` with `block_id`). Returns the parsed JSON value. */
export async function viewAt(
  urls: readonly string[],
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  blockId: string,
  fetchFn: typeof fetch,
  record?: (e: RpcExchange) => void,
): Promise<{ url: string; value: unknown }> {
  const answer = await rpcCall(
    urls,
    "query",
    {
      request_type: "call_function",
      block_id: blockId,
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
    fetchFn,
    record,
  );
  const r = answer.result;
  if (!isRecord(r) || !Array.isArray(r.result))
    throw new RpcError(`${methodName}: the reply has no result bytes`);
  const bytes = Buffer.from(r.result as number[]);
  return { url: answer.url, value: JSON.parse(bytes.toString("utf8")) };
}
