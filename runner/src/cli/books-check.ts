// npm run books -- [--coin <account>] [--lender <account>] [--rpc <url>] [--json <file>] [--save <dir>]
//
// Read-only. Do the coin's dollars add up? At one final block: what the coin owes, bucket by bucket, from its own
// views (get_pot, get_rewards), against the test dollar's balance of the coin and what the lender's own books say
// the coin lent it, with the rule of 01 §9.7. Then the differences, and what is not in these books (stand-ins).
//   --coin <account>    The coin contract. Default: testnet.coin in intern/interface/deployments.json.
//   --lender <account>  The stand-in lender. Default: testnet.lender in deployments.json (get_constants names none).
//   --rpc <url>         NEAR testnet RPC. Default: NEAR_RPC_URL from the shell, else https://test.rpc.fastnear.com.
//   --json <file>       Also write the same data as JSON, for a web page.
//   --save <dir>        Also save every RPC exchange as received, in <dir>/rpc.json (for tests). Never overwrites.
// Needs no key and reads no .env. Exit code: 0 the books add up; 1 a difference or a failed check; 2 a call failed
// or a bad option.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { atFinalBlock } from "../at-block.ts";
import { checkBooks, readBooks } from "../books-check.ts";
import { renderBooks } from "../books-text.ts";
import { deployedTestnet } from "../deployed.ts";
import { deployedTestnetCoin } from "../deployments.ts";
import { DEFAULT_TESTNET_RPC } from "../near.ts";
import type { RpcExchange } from "../near-rpc.ts";

function fail(message: string): never {
  console.error(`books-check: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      coin: { type: "string" },
      lender: { type: "string" },
      rpc: { type: "string" },
      json: { type: "string" },
      save: { type: "string" },
    },
  });
  const coin = values.coin ?? deployedTestnetCoin() ?? fail("no coin contract: pass --coin <account>");
  const lender = values.lender ?? deployedTestnet("lender");
  const rpcUrl = values.rpc ?? (process.env.NEAR_RPC_URL || DEFAULT_TESTNET_RPC);
  const exchanges: RpcExchange[] = [];
  const at = await atFinalBlock(rpcUrl, fetch, (e) => exchanges.push(e));
  const report = checkBooks(await readBooks(at, coin, lender));
  for (const line of renderBooks(report)) console.log(line);

  if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${resolve(values.json)}`);
  }
  if (values.save !== undefined) {
    mkdirSync(values.save, { recursive: true });
    const file = join(values.save, "rpc.json");
    const what =
      `Every NEAR RPC exchange of \`npm run books -- --coin ${coin}${lender ? ` --lender ${lender}` : ""} --rpc ${rpcUrl}\`, ` +
      "saved by --save: the request sent and the reply body exactly as received.";
    writeFileSync(file, `${JSON.stringify({ what, coin, lender, block: at.block, exchanges }, null, 2)}\n`, {
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
