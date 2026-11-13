// npm run quote -- --market PEPE --side long --margin 20 [--leverage 1] [--coin <account>] [--rpc <url>] [--json]
//                  [--save <file>]
//
// "Why NOPE?" as a free dry run: the verdict a bet would get from checks 6 to 12 (01 §7) right now, with the rule in
// plain words, its 01 section and the numbers it hit. Read-only: the contract's views at the latest final block
// (get_constants, get_rank, get_round, get_pot, get_rulebook, get_positions); nothing is signed or sent, no key is
// needed and no .env is read. Checks 1 to 5 (the window, the firing, the AI's signature, the request, the decision
// line) are not part of a dry run.
//   --market <name>   One of the six markets of 01 §4 (DOGE, SHIB, PEPE, PENGU, WIF, TRUMP).
//   --side <side>     long or short.
//   --margin <usd>    The margin in dollars, up to 6 decimals (20, 12.5).
//   --leverage <n>    A whole number, 1 or more (default 1).
//   --coin <account>  The coin contract. Default: testnet.coin in intern/interface/deployments.json.
//   --rpc <url>       NEAR testnet RPC. Default: NEAR_RPC_URL from the shell, else https://test.rpc.fastnear.com.
//   --json            Print the quote as JSON instead of text.
//   --save <file>     Also save every RPC request and reply as received (for tests). Never overwrites.
// Exit code: 0 YES; 1 NOPE; 2 no quote (a bad option, a call failed, or the contract's numbers do not fit).
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chainId, finalSnapshot, READ_RPC } from "../chain-snapshot.ts";
import { deployedTestnetCoin } from "../deployments.ts";
import type { RpcExchange } from "../near-rpc.ts";
import { QuoteError, quoteFromViews, quoteLines, readBet, readQuoteViews } from "../quote.ts";

function fail(message: string): never {
  console.error(`quote: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      market: { type: "string" },
      side: { type: "string" },
      margin: { type: "string" },
      leverage: { type: "string" },
      coin: { type: "string" },
      rpc: { type: "string" },
      json: { type: "boolean" },
      save: { type: "string" },
    },
  });
  if (values.market === undefined || values.side === undefined || values.margin === undefined)
    fail(
      "usage: npm run quote -- --market PEPE --side long --margin 20 [--leverage 1] [--coin <account>] [--rpc <url>]",
    );
  const leverage = values.leverage === undefined ? 1 : Number(values.leverage);
  const bet = readBet({ market: values.market, side: values.side, margin_usd: values.margin, leverage });
  if (!bet.ok) fail(`this bet cannot be quoted: ${bet.reason}`);

  const coin = values.coin ?? deployedTestnetCoin() ?? fail("no coin contract: pass --coin <account>");
  const rpcUrl = values.rpc ?? (process.env.NEAR_RPC_URL || READ_RPC);
  const exchanges: RpcExchange[] = [];
  const record = values.save === undefined ? undefined : (e: RpcExchange) => exchanges.push(e);

  const chain = await chainId([rpcUrl], fetch, record);
  if (chain !== "testnet") fail(`${rpcUrl} is ${chain}, not testnet`);
  const snap = await finalSnapshot([rpcUrl], coin, fetch, record);
  const views = await readQuoteViews(snap.view);
  let quote: ReturnType<typeof quoteFromViews>;
  try {
    quote = quoteFromViews(views, bet.decision, { coin, now_ms: snap.block.time_ms, block: snap.block });
  } catch (e) {
    if (e instanceof QuoteError) fail(`no quote: ${e.message}`);
    throw e;
  }
  console.log(values.json ? JSON.stringify(quote, null, 2) : quoteLines(quote).join("\n"));

  if (values.save !== undefined) {
    const what =
      `Every NEAR RPC exchange of \`npm run quote\` for ${coin} (${bet.decision.market} ${bet.decision.side} ` +
      `${bet.decision.margin_e6} x${bet.decision.leverage}), saved by --save: the request sent and the reply body exactly as received.`;
    writeFileSync(values.save, `${JSON.stringify({ what, rpc: rpcUrl, coin, exchanges }, null, 2)}\n`, {
      flag: "wx",
    });
    console.error(`saved ${exchanges.length} RPC exchange(s) in ${values.save}`);
  }
  process.exitCode = quote.explanation.verdict === "NOPE" ? 1 : 0;
}

try {
  await main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
