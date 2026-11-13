import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { RpcExchange } from "../../src/near-rpc.ts";
import type { NearblocksExchange } from "../../src/nearblocks.ts";

/**
 * A test double for `fetch` that answers from recorded real replies: NEAR JSON-RPC POSTs by URL, method and params,
 * and plain GETs (NearBlocks) by URL. Anything not recorded throws, so a test cannot reach the network by mistake.
 * `calls` lists what was asked, in order.
 */
export function replayFetch(
  rpc: readonly RpcExchange[],
  gets: readonly NearblocksExchange[] = [],
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (init?.method === "POST") {
      const sent = JSON.parse(String(init.body)) as { method: string; params: unknown };
      calls.push(`${sent.method} ${url}`);
      const hit = rpc.find(
        (e) =>
          e.url === url &&
          e.request.method === sent.method &&
          JSON.stringify(e.request.params) === JSON.stringify(sent.params),
      );
      if (!hit) throw new Error(`not recorded: ${sent.method} ${JSON.stringify(sent.params)} on ${url}`);
      return new Response(hit.body, { status: hit.status });
    }
    calls.push(`GET ${url}`);
    const hit = gets.find((e) => e.url === url);
    if (!hit) throw new Error(`not recorded: GET ${url}`);
    return new Response(hit.body, { status: hit.status });
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** A JSON file of test/data (gzipped when it ends in .gz). */
export function readData<T>(path: string): T {
  const raw = readFileSync(new URL(`../data/${path}`, import.meta.url));
  return JSON.parse((path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as T;
}

/** A JSON-RPC reply body as NEAR sends it, for hand-made replies. */
export const rpcBody = (result: unknown): string => JSON.stringify({ jsonrpc: "2.0", id: "x", result });

/** A fetch answering JSON-RPC by `request_type` (or method) and account, from a table of results; for synthetic cases. */
export function fakeRpc(
  answer: (method: string, params: Record<string, unknown>) => unknown,
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (_input: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    calls.push(
      `${sent.method} ${String(sent.params.request_type ?? "")} ${String(sent.params.account_id ?? "")}`,
    );
    const result = answer(sent.method, sent.params);
    if (result instanceof Error)
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: result.message },
        }),
        { status: 200 },
      );
    return new Response(rpcBody(result), { status: 200 });
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}
