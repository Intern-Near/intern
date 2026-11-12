// npm run cues -- [--contract <account>] [--last <n>] [--follow]
//
// Reads the coin's feed (01 §10: get_feed, polled every 3 seconds, as the site does) and prints one cue per event as
// a JSON line: the pose, the mascot, what the Intern says and the program's caption. A stream overlay or a
// text-to-speech step can read this output. Read-only: it sends nothing and needs no key.
//   --last <n>   start with the latest n events (default 10)
//   --follow     keep polling for new events (otherwise print and stop)
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type CueContext, cueFor, type FeedItem, type Lines } from "./cues.ts";

const LINES = JSON.parse(
  readFileSync(new URL("../../interface/lines.json", import.meta.url), "utf8"),
) as Lines;
const RPC = process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com";

const { values } = parseArgs({
  options: {
    contract: { type: "string" },
    last: { type: "string" },
    follow: { type: "boolean" },
  },
});

async function view(contract: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(RPC, {
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
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const body = (await res.json()) as { result?: { result?: number[] }; error?: unknown };
  if (!body.result?.result) throw new Error(`${method}: ${JSON.stringify(body.error ?? body)}`);
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
}

async function main(): Promise<void> {
  const contract = values.contract ?? "coin.desk-lab-2026.testnet";
  const last = Number(values.last ?? 10);
  const ctx: CueContext = {};
  let after: number | null = null;
  for (;;) {
    const rank = (await view(contract, "get_rank", {})) as { rank?: string };
    if (rank.rank) ctx.rank = rank.rank;
    const items = (await view(
      contract,
      "get_feed",
      after === null ? { limit: last } : { after_seq: after, limit: 50 },
    )) as FeedItem[];
    for (const item of items) {
      const cue = cueFor(item, LINES, ctx);
      if (cue) console.log(JSON.stringify(cue));
      after = Math.max(after ?? 0, item.seq);
    }
    if (after === null) after = 0;
    if (!values.follow) return;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

await main();
