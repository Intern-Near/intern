// npm run runner -- <command> --contract <account> [options]
//
// The Intern's runner (03 brief, step 5). Commands:
//   status            Read-only: the program's constants, rank, round, this round's bets. No key needed.
//   preflight         Read-only: every check the runner needs, in one go: the views and their shapes, the rulebook
//                     against 01 §6.1, the Hyperliquid address against NEAR's signing network, the pinned model and
//                     signer against NEAR AI, both accounts and their keys, the Hyperliquid testnet balance.
//   dry               Steps 1 to 8 once: wait for the proposal window, ask the model, propose, read the verdict, stop.
//                     Needs NEARAI_API_KEY and the runner account.
//   once              One whole round from wherever it is now: also sign, deliver, close, report, settle. Calls
//                     rebalance once, before proposing (01 1.3 §9.6). Needs NEARAI_API_KEY, the runner account
//                     (propose, sign_next, report_result) and the relayer account (rebalance, close, settle).
//   loop              `once`, round after round, until stopped (Ctrl-C) or it gives up.
//   trick --message <text> [--credited-to <account>]
//                     The challenge-page entry point: steps 3 to 8 with a visitor's message as the last line of the
//                     user message. The rulebook is still the program's. --credited-to names the visitor's NEAR
//                     account, sent as propose's credited_to (01 1.3 §9.5: the first credited refusal of each code
//                     lets that visitor claim its sticker). The program cannot check the name.
// Options:
//   --contract <id>   The program's account. Default: intern/interface/deployments.json testnet.coin, the real
//                     contract (01 §13). Pass the stub's name (testnet.stub there) to work against the stub.
//   --max-asks <n>    Most exchanges with the model per round (default 1). Asking again needs a bet left.
//   --slippage-bps <n> How far through the market an order's limit price is set (default 100 = 1%).
//   --instruction <text> The last line of the user message (default "Decide this round's bet.").
// Environment (from .env): NEARAI_API_KEY, RUNNER_ACCOUNT_ID, RUNNER_PRIVATE_KEY, RELAYER_ACCOUNT_ID,
// RELAYER_PRIVATE_KEY, NEAR_RPC_URL (default https://test.rpc.fastnear.com). Testnet only: the runner refuses to
// start on any other network.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Chain, NearChain } from "../chain.ts";
import type { Constants } from "../contract.ts";
import { isRecord } from "../json.ts";
import { fileLog } from "../log.ts";
import { DEFAULT_TESTNET_RPC, provider, signingAccount } from "../near.ts";
import { FIXTURES_DIR } from "../paths.ts";
import { checkKey, preflight } from "../preflight.ts";
import { checkConstants, DEFAULT_SETTINGS, isAccountId, Runner, type Settings } from "../round.ts";
import { readSecret } from "../secret.ts";

const RUNNER_DIR = new URL("../../", import.meta.url).pathname;
const DEPLOYMENTS = new URL("../../../interface/deployments.json", import.meta.url).pathname;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    contract: { type: "string" },
    "max-asks": { type: "string" },
    "slippage-bps": { type: "string" },
    instruction: { type: "string" },
    message: { type: "string" },
    "credited-to": { type: "string" },
  },
});
const command = positionals[0];

function fail(message: string): never {
  console.error(`runner: ${message}`);
  process.exit(1);
}

function whole(name: string, v: string | undefined, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function contractId(): string {
  if (values.contract) return values.contract;
  if (existsSync(DEPLOYMENTS)) {
    const d: unknown = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"));
    const coin = isRecord(d) && isRecord(d.testnet) ? d.testnet.coin : undefined;
    if (typeof coin === "string" && coin !== "") return coin;
  }
  fail("no contract: pass --contract <account> (intern/interface/deployments.json names no testnet coin)");
}

function printStatus(
  c: Constants,
  rank: unknown,
  round: unknown,
  positions: unknown,
  problems: string[],
): void {
  console.log(
    `interface ${c.interface_version}, ${c.network}; model ${c.model.id} (${c.model.signing_algo}, signer ${c.model.signer})`,
  );
  console.log(
    `runner account ${c.runner}; Hyperliquid ${c.hl.testnet ? "testnet" : "MAINNET"} address ${c.hl.address}; results ${c.result_source}`,
  );
  console.log(
    `round timing (ms after start): propose ${c.round.propose_from_ms}-${c.round.propose_until_ms}, close from ${c.round.close_from_ms}, length ${c.round.round_ms}`,
  );
  for (const p of problems) console.log(`check: ${p}`);
  console.log(`rank: ${JSON.stringify(rank)}`);
  console.log(`round: ${JSON.stringify(round)}`);
  console.log(`bets this round: ${JSON.stringify(positions)}`);
}

async function main(): Promise<void> {
  if (!["status", "preflight", "dry", "once", "loop", "trick"].includes(command ?? "")) {
    fail(
      "usage: npm run runner -- status|preflight|dry|once|loop|trick --contract <account> [options] (see src/cli/run.ts)",
    );
  }
  if (values["credited-to"] !== undefined && command !== "trick")
    fail("--credited-to is for the trick command only: it names the visitor whose message was used");
  const contract = contractId();
  const rpcUrl = process.env.NEAR_RPC_URL || DEFAULT_TESTNET_RPC;
  const rpc = provider(rpcUrl);
  const node = await rpc.viewNodeStatus();
  if (node.chain_id !== "testnet")
    fail(`${rpcUrl} is ${node.chain_id}, not testnet; the runner works on testnet only`);

  const readOnly = new NearChain(rpc, contract, null, null);
  if (command === "preflight") {
    const secret = (id: string, key: string) => {
      const accountId = process.env[id];
      const k = readSecret(key, process.env);
      return accountId && k ? { id: accountId, key: k } : null;
    };
    const lines = await preflight({
      rpc,
      chain: readOnly,
      fetchFn: fetch,
      env: process.env,
      runner: secret("RUNNER_ACCOUNT_ID", "RUNNER_PRIVATE_KEY"),
      relayer: secret("RELAYER_ACCOUNT_ID", "RELAYER_PRIVATE_KEY"),
    });
    const sign = { ok: "✔", warn: "⚠", fail: "✖" } as const;
    console.log(`preflight for ${contract} on ${rpcUrl} (testnet)`);
    for (const l of lines) console.log(`${sign[l.mark]} ${l.what}: ${l.detail}`);
    const failed = lines.filter((l) => l.mark === "fail").length;
    console.log(failed === 0 ? "ready" : `${failed} check(s) failed`);
    process.exitCode = failed === 0 ? 0 : 1;
    return;
  }
  const c = await readOnly.constants();
  const problems = checkConstants(c);
  const fatal = problems.filter((p) => !p.startsWith("warning:"));

  if (command === "status") {
    const round = await readOnly.round();
    printStatus(c, await readOnly.rank(), round, await readOnly.positions(round.id), problems);
    process.exitCode = fatal.length > 0 ? 1 : 0;
    return;
  }
  if (fatal.length > 0) fail(`the program's constants do not suit this runner:\n  ${fatal.join("\n  ")}`);
  for (const p of problems) console.log(`check: ${p}`);

  const apiKey = readSecret("NEARAI_API_KEY", process.env);
  if (apiKey === null) fail("NEARAI_API_KEY is not set (put it in runner/.env)");
  const runnerId = process.env.RUNNER_ACCOUNT_ID;
  const runnerKey = readSecret("RUNNER_PRIVATE_KEY", process.env);
  if (!runnerId || runnerKey === null) fail("RUNNER_ACCOUNT_ID and RUNNER_PRIVATE_KEY must be set");
  if (runnerId !== c.runner) fail(`only ${c.runner} may propose (get_constants().runner), not ${runnerId}`);
  const runnerCheck = await checkKey(rpc, runnerId, runnerKey, "runner", contract);
  if (runnerCheck.problem) fail(runnerCheck.problem);
  console.log(`runner key: ${runnerCheck.detail}`);

  const needsRelayer = command === "once" || command === "loop";
  let relayer = null;
  if (needsRelayer) {
    const relayerId = process.env.RELAYER_ACCOUNT_ID;
    const relayerKey = readSecret("RELAYER_PRIVATE_KEY", process.env);
    if (!relayerId || relayerKey === null)
      fail("RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY must be set for this command");
    if (relayerId === runnerId) fail("the relayer must be a separate account from the runner");
    const relayerCheck = await checkKey(rpc, relayerId, relayerKey, "relayer", contract);
    if (relayerCheck.problem) fail(relayerCheck.problem);
    relayer = signingAccount(relayerId, relayerKey, rpc);
  }
  const chain: Chain = new NearChain(rpc, contract, signingAccount(runnerId, runnerKey, rpc), relayer);

  const settings: Settings = {
    maxAsks: whole("max-asks", values["max-asks"], DEFAULT_SETTINGS.maxAsks, 1, 10),
    slippageBps: whole("slippage-bps", values["slippage-bps"], DEFAULT_SETTINGS.slippageBps, 1, 1_000),
    instruction: values.instruction ?? DEFAULT_SETTINGS.instruction,
  };

  // One runner at a time per contract: two would race for the same nonce.
  const dataDir = join(RUNNER_DIR, "logs", contract);
  const lock = join(dataDir, "runner.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) fail(`another runner (pid ${pid}) is working on ${contract}; stop it first`);
  }
  const log = fileLog(join(dataDir, "runner.jsonl"), (text) => console.log(text));
  writeFileSync(lock, String(process.pid));
  const unlock = () => rmSync(lock, { force: true });
  process.on("exit", unlock);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log({ step: "stopped", signal: sig });
      process.exit(130);
    });
  }

  const runner = new Runner(
    {
      chain,
      apiKey,
      fetchFn: fetch,
      log,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      dataDir,
      hlSaveDir: join(FIXTURES_DIR, "hl", "exchange"),
    },
    settings,
    c,
  );
  log({ step: "start", command, contract, rpc: rpcUrl, settings });

  if (command === "trick") {
    const message = values.message;
    if (!message) fail("trick needs --message <text>");
    const creditedTo = values["credited-to"] ?? null;
    if (creditedTo !== null && !isAccountId(creditedTo))
      fail(`--credited-to ${JSON.stringify(creditedTo)} is not a NEAR account id`);
    const v = await runner.trick(message, creditedTo);
    process.exitCode = v === null ? 1 : 0;
    return;
  }
  if (command === "dry") {
    process.exitCode = (await runner.runRound("dry")) === "dry-done" ? 0 : 1;
    return;
  }
  if (command === "once") {
    process.exitCode = (await runner.runRound("full")) === "settled" ? 0 : 1;
    return;
  }
  for (;;) {
    if ((await runner.runRound("full")) === "gave-up") {
      process.exitCode = 1;
      return;
    }
  }
}

try {
  await main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
