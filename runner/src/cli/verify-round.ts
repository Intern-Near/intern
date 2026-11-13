// npm run verify-round -- <tx hash> [--sender intern-runner-ed25519.testnet] [--rpc <url>] [--save <dir>]
// Re-checks one propose transaction from public data: NEAR RPC only (an archival node if the regular one no longer
// has it), no key, no NEAR AI call. Read-only. With --save, every RPC reply is kept in <dir>/rpc.json (for tests).
// Exit code: 0 everything verified and the contract's verdict fits; 1 a problem or a part not checked; 2 the
// transaction could not be read or is not a proposal.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_TESTNET_RPC } from "../near.ts";
import { type RpcExchange, TESTNET_ARCHIVAL_RPCS } from "../near-rpc.ts";
import { verifyRound } from "../verify-round.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const FLAGS = new Set(["--sender", "--rpc", "--save"]);
const positional = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith("--") && !FLAGS.has(all[i - 1] ?? ""));
const txHash = positional[0];
if (txHash === undefined || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(txHash)) {
  console.error("usage: npm run verify-round -- <tx hash> [--sender <account>] [--rpc <url>] [--save <dir>]");
  process.exit(2);
}
const primary = flag("--rpc") ?? DEFAULT_TESTNET_RPC;
const rpcs = [primary, ...TESTNET_ARCHIVAL_RPCS.filter((u) => u !== primary)];
const save = flag("--save");
const exchanges: RpcExchange[] = [];

const report = await verifyRound({
  txHash,
  sender: flag("--sender") ?? "intern-runner-ed25519.testnet",
  rpcs,
  fetchFn: fetch,
  record: (e) => exchanges.push(e),
});
console.log(`verify-round, ${new Date().toISOString()}. RPC: ${rpcs.join(", then ")}`);
for (const line of report.lines) console.log(line);
if (save !== undefined) {
  await mkdir(save, { recursive: true });
  const file = join(save, "rpc.json");
  const what = `Every NEAR RPC exchange of \`npm run verify-round -- ${txHash}\`, saved by --save: the request sent and the reply body exactly as received.`;
  await writeFile(file, `${JSON.stringify({ what, exchanges }, null, 2)}\n`, { flag: "wx" });
  console.log(`saved ${exchanges.length} RPC exchange(s) in ${file}`);
}
process.exitCode = report.fatal !== null ? 2 : report.failures + report.unverified > 0 ? 1 : 0;
