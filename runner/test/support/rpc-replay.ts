import { readFileSync } from "node:fs";
import type { Block } from "../../src/at-block.ts";
import type { RpcExchange } from "../../src/near-rpc.ts";

/**
 * TEST ONLY. Replays NEAR RPC exchanges saved by `--save` (`npm run books` and `npm run supply-log`): each JSON-RPC
 * request is answered with the reply recorded for the same URL, method and params; anything not recorded fails.
 */

export interface Recording {
  what: string;
  coin: string;
  lender?: string | null;
  block: Block;
  exchanges: RpcExchange[];
}

export function loadRecording(url: URL): Recording {
  return JSON.parse(readFileSync(url, "utf8")) as Recording;
}

export function replayRpc(exchanges: readonly RpcExchange[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    const hit = exchanges.find(
      (e) =>
        e.url === String(url) &&
        e.request.method === sent.method &&
        JSON.stringify(e.request.params) === JSON.stringify(sent.params),
    );
    if (!hit) throw new Error(`no recorded reply for ${sent.method} ${JSON.stringify(sent.params)}`);
    return new Response(hit.body, { status: hit.status });
  }) as typeof fetch;
}

/** The value a recorded `query` (call_function) of `method` returned, parsed from its result bytes. */
export function recordedView(exchanges: readonly RpcExchange[], method: string, argsJson = "{}"): unknown {
  const want = Buffer.from(argsJson).toString("base64");
  const hit = exchanges.find(
    (e) => e.request.params.method_name === method && e.request.params.args_base64 === want,
  );
  if (!hit) throw new Error(`no recorded ${method} ${argsJson}`);
  const bytes = (JSON.parse(hit.body) as { result: { result: number[] } }).result.result;
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}
