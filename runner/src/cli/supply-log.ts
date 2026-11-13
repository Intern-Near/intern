// npm run supply-log -- [--coin <account>] [--rpc <url>] [--json <file>] [--csv <file>] [--save <dir>]
//
// Read-only. Every mint and burn of $INTERN coins, rebuilt from the coin's feed (get_feed, every page) at one final
// block: coins created at each round's opening from BRAVE money (with the contract's own rule), coins written to
// accounts (coins_minted), coins burned at cash-out and by the dial to SAFE. One line per event, a table per round,
// and the total against ft_total_supply at the same block. What the feed cannot account for is said plainly.
//   --coin <account>  The coin contract. Default: testnet.coin in intern/interface/deployments.json.
//   --rpc <url>       NEAR testnet RPC. Default: NEAR_RPC_URL from the shell, else https://test.rpc.fastnear.com.
//   --json <file>     Also write the whole log as JSON, for a web page.
//   --csv <file>      Also write the event-by-event log as CSV (amounts with 6 decimals).
//   --save <dir>      Also save every RPC exchange as received, in <dir>/rpc.json (for tests). Never overwrites.
// Needs no key and reads no .env. Exit code: 0 the feed accounts for every coin; 1 a difference or a gap; 2 a call
// failed or a bad option.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { atFinalBlock } from "../at-block.ts";
import { deployedTestnetCoin } from "../deployments.ts";
import { DEFAULT_TESTNET_RPC } from "../near.ts";
import type { RpcExchange } from "../near-rpc.ts";
import { readSupply, rebuild } from "../supply-log.ts";
import { renderCsv, renderSupply } from "../supply-text.ts";

function fail(message: string): never {
  console.error(`supply-log: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      coin: { type: "string" },
      rpc: { type: "string" },
      json: { type: "string" },
      csv: { type: "string" },
      save: { type: "string" },
    },
  });
  const coin = values.coin ?? deployedTestnetCoin() ?? fail("no coin contract: pass --coin <account>");
  const rpcUrl = values.rpc ?? (process.env.NEAR_RPC_URL || DEFAULT_TESTNET_RPC);
  const exchanges: RpcExchange[] = [];
  const at = await atFinalBlock(rpcUrl, fetch, (e) => exchanges.push(e));
  const report = rebuild(await readSupply(at, coin));
  for (const line of renderSupply(report)) console.log(line);

  if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${resolve(values.json)}`);
  }
  if (values.csv !== undefined) {
    writeFileSync(values.csv, renderCsv(report));
    console.log(`wrote ${resolve(values.csv)}`);
  }
  if (values.save !== undefined) {
    mkdirSync(values.save, { recursive: true });
    const file = join(values.save, "rpc.json");
    const what =
      `Every NEAR RPC exchange of \`npm run supply-log -- --coin ${coin} --rpc ${rpcUrl}\`, saved by --save: ` +
      "the request sent and the reply body exactly as received.";
    writeFileSync(file, `${JSON.stringify({ what, coin, block: at.block, exchanges }, null, 2)}\n`, {
      flag: "wx",
    });
    console.log(`saved ${exchanges.length} RPC exchange(s) in ${resolve(file)}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

try {
  await main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
