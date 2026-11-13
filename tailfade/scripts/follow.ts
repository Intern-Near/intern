// Copy trading from a terminal (01 1.7, item 18): follows the Intern's bets with one rule, using a Tail or Fade
// trading key that the visitor already approved (it can trade, never withdraw).
//
//   AGENT_KEY=<hex of the approved trading key> ACCOUNT=<the visitor's Hyperliquid address> \
//     node scripts/follow.ts --choice TAIL --chip 10 --leverage 2 --max-per-day 6
//
// Polls the coin's feed every 15 seconds; when a window opens for a bet not followed yet, places the chip. Ctrl-C
// stops it. Nothing is stored but what it prints.
import { parseArgs } from "node:util";
import { checkRule, type FollowRule, nextFollow } from "../src/follow.ts";
import { agentFromHex, type FeedItem, placeChip } from "../src/tailfade.ts";

const { values } = parseArgs({
  options: {
    choice: { type: "string", default: "TAIL" },
    chip: { type: "string", default: "10" },
    leverage: { type: "string", default: "2" },
    "max-per-day": { type: "string", default: "6" },
    coin: { type: "string", default: "coin.desk-lab-2026.testnet" },
    rpc: { type: "string", default: "https://test.rpc.fastnear.com" },
  },
});
const rule = {
  choice: values.choice,
  chipUsd: Number(values.chip),
  leverage: Number(values.leverage),
  maxPerDay: Number(values["max-per-day"]),
} as FollowRule;
const bad = checkRule(rule);
if (bad) throw new Error(bad);
const key = process.env.AGENT_KEY?.trim();
if (!key) throw new Error("AGENT_KEY (the approved trading key, hex) is required");
const agent = agentFromHex(key);

async function feed(): Promise<FeedItem[]> {
  const args = Buffer.from(JSON.stringify({ limit: 50 })).toString("base64");
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: values.coin, method_name: "get_feed", args_base64: args },
  };
  const r = (await (
    await fetch(values.rpc as string, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  ).json()) as { result: { result: number[] } };
  return JSON.parse(Buffer.from(r.result.result).toString()) as FeedItem[];
}

const done = new Set<number>();
const placedAt: number[] = [];
console.log(`following: ${rule.choice} $${rule.chipUsd} at ${rule.leverage}x, at most ${rule.maxPerDay} a day`);
for (;;) {
  try {
    const w = nextFollow(await feed(), rule, done, placedAt, Date.now());
    if (w) {
      done.add(w.position_id);
      const r = await placeChip({ agent, market: w.market, choice: rule.choice, internSide: w.side, chipUsd: rule.chipUsd, leverage: rule.leverage });
      placedAt.push(Date.now());
      console.log(new Date().toISOString(), `bet ${w.position_id} ${w.market} ${w.side}:`, JSON.stringify(r).slice(0, 300));
    }
  } catch (e) {
    console.log(new Date().toISOString(), "error:", e instanceof Error ? e.message : String(e));
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
