// npm run proof -- [--json <file>] [--coin <account>] [--relayer <account>] [--rounds N] [--proposals N] [--rpc <url>]
//
// Read-only. The proof bundle (src/proof.ts): one JSON file for a public proof page, gathered in one run by calling the
// read-only tools' libraries directly: the contract scan, the runner's and relayer's keys, fills-check over the last N
// rounds, verify-round on the last few proposals, NEAR AI's attestation check and the refusal catalogue, each a section
// with ok, warn or fail, one plain sentence and its raw data; plus the time, the endpoints and the git commit. A
// section that fails is recorded, and the others still run. The JSON shape is in runner/README.md ("proof").
//   --json <file>        Write the bundle there (without it, only the summary is printed).
//   --coin <account>     The coin contract. Default: testnet.coin in intern/interface/deployments.json.
//   --relayer <account>  The relayer account. Default: intern-relayer-ed25519.testnet (runner/README, "key-scope").
//   --rounds <n>         fills-check's rounds, 1 to 200 (default 10).
//   --proposals <n>      How many of the latest proposals to re-check, 1 to 25 (default 3).
//   --rpc <url>          NEAR testnet RPC. Default: NEAR_RPC_URL from the shell, else https://test.rpc.fastnear.com.
// Needs no key and reads no .env. Exit code: 0 no section failed; 1 a section failed; 2 a bad option, or the RPC is
// not testnet.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { isAccountId, protocolFacts } from "../contract-scan.ts";
import { deployedTestnetCoin } from "../deployments.ts";
import { MAX_ROUNDS } from "../fills-check.ts";
import { readGitHead } from "../git-head.ts";
import { DEFAULT_TESTNET_RPC } from "../near.ts";
import { buildBundle, endpointsOf, realJobs } from "../proof.ts";

/** The relayer of the live run (runner/README, "key-scope"); deployments.json does not name it. */
const DEFAULT_RELAYER = "intern-relayer-ed25519.testnet";

function fail(message: string): never {
  console.error(`proof: ${message}`);
  process.exit(2);
}

function whole(v: string | undefined, fallback: number, max: number, name: string): number {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`${name} must be a whole number from 1 to ${max}`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      json: { type: "string" },
      coin: { type: "string" },
      relayer: { type: "string" },
      rounds: { type: "string" },
      proposals: { type: "string" },
      rpc: { type: "string" },
    },
  });
  const coin = values.coin ?? deployedTestnetCoin() ?? fail("no coin contract: pass --coin <account>");
  const relayer = values.relayer ?? DEFAULT_RELAYER;
  for (const a of [coin, relayer]) if (!isAccountId(a)) fail(`${a} is not a NEAR account id`);
  const rpcUrl = values.rpc ?? (process.env.NEAR_RPC_URL || DEFAULT_TESTNET_RPC);
  const { chainId } = await protocolFacts({ urls: [rpcUrl], fetchFn: fetch });
  if (chainId !== "testnet") fail(`${rpcUrl} is ${chainId ?? "not answering"}, not testnet`);
  const cfg = {
    coin,
    relayer,
    rounds: whole(values.rounds, 10, MAX_ROUNDS, "--rounds"),
    proposals: whole(values.proposals, 3, 25, "--proposals"),
    rpcUrl,
    fetchFn: fetch,
    now: () => Date.now(),
    nonce: () => randomBytes(32).toString("hex"),
  };
  const bundle = await buildBundle({
    jobs: realJobs(cfg),
    coin,
    git: readGitHead(),
    endpoints: endpointsOf(cfg),
    now: cfg.now,
  });
  console.log(
    `proof bundle, ${bundle.generated_at} to ${bundle.finished_at}, testnet, coin ${coin}, commit ${bundle.git?.commit ?? "unknown (no .git here)"}. Read-only.`,
  );
  for (const s of bundle.sections)
    console.log(
      `  ${s.status.toUpperCase().padEnd(4)}  ${s.id.padEnd(13)} ${s.sentence} (${(s.took_ms / 1000).toFixed(1)} s)`,
    );
  console.log(`SUMMARY  ${bundle.summary.sentence}`);
  if (values.json !== undefined) {
    writeFileSync(values.json, `${JSON.stringify(bundle, null, 2)}\n`);
    console.log(`wrote ${resolve(values.json)}`);
  }
  process.exitCode = bundle.summary.fail > 0 ? 1 : 0;
}

try {
  await main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
