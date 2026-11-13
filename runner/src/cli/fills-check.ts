// npm run fills-check -- [--coin <account>] [--rounds N] [--rpc <url>] [--json <file>] [--save <dir>]
//
// Read-only. For the last N rounds of a coin contract (default 10, the current round included): the orders the
// contract signed and the results the runner reported, checked against Hyperliquid testnet's own fills for the
// contract's address, with the runner's own rule. One line per bet, then a summary.
//   --coin <account>  The coin contract. Default: testnet.coin in intern/interface/deployments.json.
//   --rounds <n>      How many rounds back, 1 to 200 (default 10).
//   --rpc <url>       NEAR testnet RPC. Default: NEAR_RPC_URL from the shell, else https://test.rpc.fastnear.com.
//   --json <file>     Also write the same data as JSON, for a web page.
//   --save <dir>      Also save every view and Hyperliquid reply as received (for tests). Never overwrites.
// Needs no key and reads no .env. Exit code: 0 everything matches; 1 a MISMATCH or a fill no signed order accounts
// for; 2 a call failed or a bad option.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { deployedTestnetCoin } from "../deployments.ts";
import { analyze, gather, MAX_ROUNDS } from "../fills-check.ts";
import { renderText } from "../fills-text.ts";
import { HL_TESTNET_INFO, type InfoRecord } from "../hl-exchange.ts";
import { DEFAULT_TESTNET_RPC, provider, view } from "../near.ts";

function fail(message: string): never {
  console.error(`fills-check: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      coin: { type: "string" },
      rounds: { type: "string" },
      rpc: { type: "string" },
      json: { type: "string" },
      save: { type: "string" },
    },
  });
  const contract = values.coin ?? deployedTestnetCoin() ?? fail("no coin contract: pass --coin <account>");
  const rounds = values.rounds === undefined ? 10 : Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS)
    fail(`--rounds must be a whole number from 1 to ${MAX_ROUNDS}`);
  const rpcUrl = values.rpc ?? (process.env.NEAR_RPC_URL || DEFAULT_TESTNET_RPC);
  const rpc = provider(rpcUrl);
  const node = await rpc.viewNodeStatus();
  if (node.chain_id !== "testnet") fail(`${rpcUrl} is ${node.chain_id}, not testnet`);

  const views: { method: string; args: Record<string, unknown>; result: unknown }[] = [];
  const replies: InfoRecord[] = [];
  const g = await gather(
    {
      contract,
      view: async (method, args) => {
        const result = await view(rpc, contract, method, args);
        views.push({ method, args, result });
        return result;
      },
      fetchFn: fetch,
      now: () => Date.now(),
      keep: (r) => replies.push(r),
    },
    rounds,
  );
  const report = analyze(g, rpcUrl);
  for (const line of renderText(report)) console.log(line);

  if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${resolve(values.json)}`);
  }
  if (values.save !== undefined) {
    const at = { fetched_at: report.checked_at, checked_at_ms: g.checked_at };
    mkdirSync(values.save, { recursive: true });
    writeFileSync(
      join(values.save, "chain-views.json"),
      `${JSON.stringify({ ...at, rpc: rpcUrl, contract, rounds, views }, null, 2)}\n`,
      { flag: "wx" },
    );
    writeFileSync(
      join(values.save, "hl-info.json"),
      `${JSON.stringify({ ...at, url: HL_TESTNET_INFO, records: replies }, null, 2)}\n`,
      { flag: "wx" },
    );
    console.log(
      `saved ${views.length} view(s) and ${replies.length} Hyperliquid reply(ies) in ${resolve(values.save)}`,
    );
  }
  process.exitCode = report.summary.ok ? 0 : 1;
}

try {
  await main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
