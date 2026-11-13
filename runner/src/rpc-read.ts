import { isRecord } from "./json.ts";
import type { KeyReader } from "./key-scope.ts";
import { RpcError, type RpcExchange, rpcCall } from "./near-rpc.ts";

/**
 * Read-only NEAR RPC queries at the latest final block, over the small JSON-RPC client of near-rpc.ts, so that every
 * reply goes through one `fetch` (and can be kept with `record` and replayed in tests). The query kinds are NEAR's
 * (docs.near.org/api/rpc): `view_account`, `view_code`, `view_access_key_list` and `call_function`; each was run
 * against testnet on 2026-11-13.
 */
export interface RpcReader {
  /** Tried in order (near-rpc.ts moves on only when a node does not have the data). */
  urls: readonly string[];
  fetchFn: typeof fetch;
  record?: (e: RpcExchange) => void;
}

/** A `query` at the latest final block. Returns the reply's `result`. */
export async function queryFinal(
  r: RpcReader,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const a = await rpcCall(r.urls, "query", { ...params, finality: "final" }, r.fetchFn, r.record);
  if (!isRecord(a.result))
    throw new RpcError(`query ${String(params.request_type)}: the reply has no result`);
  return a.result;
}

/** A contract view at the latest final block; the parsed JSON it returns. */
export async function viewFinal(
  r: RpcReader,
  contract: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await queryFinal(r, {
    request_type: "call_function",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (!Array.isArray(res.result)) throw new RpcError(`${contract} ${method}: the reply has no result bytes`);
  return JSON.parse(Buffer.from(res.result as number[]).toString("utf8"));
}

/** `view_access_key_list` in the shape key-scope.ts reads (near-api-js's `viewAccessKeyList`). */
export function keyReader(r: RpcReader): KeyReader {
  const viewAccessKeyList = ({ accountId }: { accountId: string }) =>
    queryFinal(r, { request_type: "view_access_key_list", account_id: accountId });
  return { viewAccessKeyList: viewAccessKeyList as unknown as KeyReader["viewAccessKeyList"] };
}
