// npm run refusals -- [--coin <account>]... [--no-tx] [--rpc <url>] [--json <file>] [--save <dir>]
//
// Read-only. The refusal catalogue (src/refusals.ts): every refusal a coin recorded (get_refusals, all pages), grouped
// under the sixteen codes of interface/refusal-codes.json, with each code's count and first example (round, numbers,
// the bet), the codes with no example yet, and the first example's transaction: found with NearBlocks' public API
// and confirmed with NEAR RPC (an archival node for old ones), with an explorer link.
//   --coin <account>  A coin contract; repeat for more. Default: testnet.coin of intern/interface/deployments.json and
//                     the test copy coin-fast.desk-lab-2026.testnet.
//   --no-tx           Do not look the transactions up (no NearBlocks call).
//   --rpc <url>       NEAR testnet RPC. Default: NEAR_RPC_URL from the shell, else https://test.rpc.fastnear.com.
//   --json <file>     Also write the same data as JSON, for a web page.
//   --save <dir>      Also save every RPC and NearBlocks reply as received (for tests), in <dir>/replies.json.
// Needs no key and reads no .env. Exit code: 0 read; 2 a refusal list could not be read, a bad option, or the RPC is
// not testnet. A transaction that cannot be found is a line in the output, not a failure.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isAccountId, protocolFacts } from "../contract-scan.ts";
import { deployedTestnetCoin } from "../deployments.ts";
import { DEFAULT_TESTNET_RPC } from "../near.ts";
import { type RpcExchange, TESTNET_ARCHIVAL_RPCS } from "../near-rpc.ts";
import { NEARBLOCKS_TESTNET_API, type NearblocksExchange } from "../nearblocks.ts";
import {
  COIN_FAST,
  type CoinCatalogue,
  catalogue,
  findRefusalTx,
  readAllRefusals,
  readCodeTable,
  renderRefusals,
  summarize,
} from "../refusals.ts";
import { type RpcReader, viewFinal } from "../rpc-read.ts";

function fail(message: string): never {
  console.error(`refusals: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      coin: { type: "string", multiple: true },
      "no-tx": { type: "boolean" },
      rpc: { type: "string" },
      json: { type: "string" },
      save: { type: "string" },
    },
  });
  const coins = values.coin ?? [
    deployedTestnetCoin() ?? fail("no coin contract: pass --coin <account>"),
    COIN_FAST,
  ];
  const bad = coins.filter((c) => !isAccountId(c));
  if (bad.length > 0) fail(`--coin must be a NEAR account id (${bad.join(", ")})`);
  const rpcUrl = values.rpc ?? (process.env.NEAR_RPC_URL || DEFAULT_TESTNET_RPC);
  const { chainId } = await protocolFacts({ urls: [rpcUrl], fetchFn: fetch });
  if (chainId !== "testnet") fail(`${rpcUrl} is ${chainId ?? "not answering"}, not testnet`);
  const rpcs = [rpcUrl, ...TESTNET_ARCHIVAL_RPCS.filter((u) => u !== rpcUrl)];
  const exchanges: RpcExchange[] = [];
  const nearblocks: NearblocksExchange[] = [];
  const reader: RpcReader = { urls: [rpcUrl], fetchFn: fetch, record: (e) => exchanges.push(e) };
  const { codes, source } = readCodeTable();
  const checkedAt = new Date().toISOString();

  const catalogues: CoinCatalogue[] = [];
  for (const coin of coins) {
    const refusals = await readAllRefusals((method, args) => viewFinal(reader, coin, method, args));
    const lookup = values["no-tx"]
      ? null
      : (r: Parameters<typeof findRefusalTx>[2]) =>
          findRefusalTx(
            {
              fetchFn: fetch,
              rpcs,
              record: (e) => exchanges.push(e),
              recordNearblocks: (e) => nearblocks.push(e),
            },
            coin,
            r,
          );
    catalogues.push(await catalogue(coin, refusals, codes, lookup));
  }
  const report = summarize(catalogues, {
    checked_at: checkedAt,
    rpc: rpcUrl,
    nearblocks: values["no-tx"] ? null : NEARBLOCKS_TESTNET_API,
    codes_source: source,
  });
  for (const line of renderRefusals(report)) console.log(line);

  if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${resolve(values.json)}`);
  }
  if (values.save !== undefined) {
    mkdirSync(values.save, { recursive: true });
    const what =
      "Every reply `npm run refusals` read, saved by --save, exactly as received: NEAR RPC exchanges (request and body) and NearBlocks GETs (url and body).";
    writeFileSync(
      join(values.save, "replies.json"),
      `${JSON.stringify({ what, checked_at: checkedAt, rpc: exchanges, nearblocks }, null, 2)}\n`,
      { flag: "wx" },
    );
    console.log(
      `saved ${exchanges.length} RPC and ${nearblocks.length} NearBlocks reply(ies) in ${resolve(values.save, "replies.json")}`,
    );
  }
}

try {
  await main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
