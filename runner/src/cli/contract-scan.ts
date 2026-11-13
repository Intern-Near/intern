// npm run contract-scan -- [--accounts a,b,...] [--rpc <url>] [--json <file>] [--save <dir>]
//
// Read-only. Who can change each NEAR testnet contract (src/contract-scan.ts): its code hash, balance and storage
// (view_account), its access keys (view_access_key_list), the NEAR host functions its deployed wasm imports (view_code,
// read by src/wasm-imports.ts), flagged when they can deploy code, add or delete keys, delete the account or use global
// contracts, and the code hash against the one docs/REPRODUCIBLE-BUILD.md records. One plain verdict per account.
//   --accounts a,b  The accounts to scan. Default: every account under testnet in intern/interface/deployments.json
//                   that holds a contract (the others are listed as skipped).
//   --rpc <url>     NEAR testnet RPC. Default: NEAR_RPC_URL from the shell, else https://test.rpc.fastnear.com.
//   --json <file>   Also write the same data as JSON, for a web page.
//   --save <dir>    Also save every RPC request and reply as received (for tests), in <dir>/rpc.json. Never overwrites.
// Needs no key and reads no .env. Exit code: 0 nothing failed (keys that can still change a contract are a warning,
// not a failure); 1 a code hash differs from the recorded one, the code read does not match its hash, or an account
// could not be read; 2 a bad option, or the RPC is not testnet.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  isAccountId,
  readDeploymentTargets,
  readRecordedHashes,
  renderScan,
  scanContracts,
  type Target,
} from "../contract-scan.ts";
import { DEFAULT_TESTNET_RPC } from "../near.ts";
import type { RpcExchange } from "../near-rpc.ts";

function fail(message: string): never {
  console.error(`contract-scan: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      accounts: { type: "string" },
      rpc: { type: "string" },
      json: { type: "string" },
      save: { type: "string" },
    },
  });
  const deployed = readDeploymentTargets();
  let targets: Target[];
  if (values.accounts !== undefined) {
    const ids = values.accounts
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a !== "");
    const bad = ids.filter((a) => !isAccountId(a));
    if (ids.length === 0 || bad.length > 0)
      fail(`--accounts must be NEAR account ids, comma-separated (${bad.join(", ")})`);
    targets = ids.map((account_id) => ({
      account_id,
      label: deployed?.find((t) => t.account_id === account_id)?.label ?? null,
    }));
  } else {
    targets = deployed ?? fail("no intern/interface/deployments.json here: pass --accounts a,b,...");
  }
  const rpcUrl = values.rpc ?? (process.env.NEAR_RPC_URL || DEFAULT_TESTNET_RPC);
  const exchanges: RpcExchange[] = [];
  const report = await scanContracts(
    { urls: [rpcUrl], fetchFn: fetch, record: (e) => exchanges.push(e) },
    targets,
    {
      recorded: readRecordedHashes(),
      skipNonContracts: values.accounts === undefined,
      now: () => new Date(),
      network: "testnet",
    },
  );
  for (const line of renderScan(report)) console.log(line);

  if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${resolve(values.json)}`);
  }
  if (values.save !== undefined) {
    mkdirSync(values.save, { recursive: true });
    const what =
      "Every NEAR RPC exchange of `npm run contract-scan`, saved by --save: the request sent and the reply body exactly as received.";
    writeFileSync(
      join(values.save, "rpc.json"),
      `${JSON.stringify({ what, checked_at: report.checked_at, exchanges }, null, 2)}\n`,
      { flag: "wx" },
    );
    console.log(`saved ${exchanges.length} RPC exchange(s) in ${resolve(values.save, "rpc.json")}`);
  }
  process.exitCode = report.summary.ok ? 0 : 1;
}

try {
  await main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
