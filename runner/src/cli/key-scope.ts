// npm run key-scope -- <account> [--expect runner|relayer] [--key <public key>] [--coin <account>] [--rpc <url>]
//
// Read-only. Every access key of a NEAR testnet account (the RPC query view_access_key_list), and a verdict on the key
// the runner or the relayer signs with (src/key-scope.ts):
//   runner   a function-call key for the coin limited to exactly propose, sign_next and report_result (01 §9.3, §13)
//   relayer  a full-access key (close attaches 1 yocto), on an account that is not the contract's runner (runner/README)
// The account's other keys are listed with a note, never as a failure.
//   --key <public key>  The key it signs with (ed25519:…). Without it every key is listed with whether it would pass
//                       as the signing key, and there is no verdict on which key the runner uses.
//   --expect <role>     runner or relayer. Default: runner when get_constants().runner names the account; otherwise
//                       the keys are only listed.
//   --coin <account>    The coin contract. Default: testnet.coin in intern/interface/deployments.json.
//   --rpc <url>         NEAR testnet RPC. Default: NEAR_RPC_URL from the shell, else https://test.rpc.fastnear.com.
// Needs no private key and reads no .env. Exit code: with --key, 0 as declared and 1 otherwise; without --key, 0 when
// some key would pass (or the keys are only listed) and 1 when none would; 2 a call failed or a bad option.
import { parseArgs } from "node:util";
import { readConstants } from "../contract.ts";
import { deployedTestnetCoin } from "../deployments.ts";
import { checkKeyScope, type Expect, formatNear, type JudgedKey } from "../key-scope.ts";
import { DEFAULT_TESTNET_RPC, provider, view } from "../near.ts";

function fail(message: string): never {
  console.error(`key-scope: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      expect: { type: "string" },
      key: { type: "string" },
      coin: { type: "string" },
      rpc: { type: "string" },
    },
  });
  const account = positionals[0];
  if (account === undefined || positionals.length !== 1)
    fail(
      "usage: npm run key-scope -- <account> [--expect runner|relayer] [--key <public key>] [--coin <account>]",
    );
  if (values.expect !== undefined && values.expect !== "runner" && values.expect !== "relayer")
    fail("--expect must be runner or relayer");
  if (values.key !== undefined && !/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(values.key))
    fail("--key must be a public key such as ed25519:<base58> (never a private key)");
  const contract = values.coin ?? deployedTestnetCoin() ?? fail("no coin contract: pass --coin <account>");
  const rpcUrl = values.rpc ?? (process.env.NEAR_RPC_URL || DEFAULT_TESTNET_RPC);
  const rpc = provider(rpcUrl);
  const node = await rpc.viewNodeStatus();
  if (node.chain_id !== "testnet") fail(`${rpcUrl} is ${node.chain_id}, not testnet`);

  const constants = readConstants(await view(rpc, contract, "get_constants"));
  const expect: Expect | null = values.expect ?? (constants.runner === account ? "runner" : null);
  if (values.key !== undefined && expect === null)
    fail(`--key needs --expect runner or relayer (${contract}'s runner is ${constants.runner})`);
  const scope = await checkKeyScope(rpc, {
    accountId: account,
    expect,
    contract,
    contractRunner: constants.runner,
    signingKey: values.key ?? null,
  });
  const balance = (await rpc.viewAccount({ accountId: account })).amount;

  const role =
    values.expect !== undefined
      ? `judged as the ${expect} of ${contract} (--expect)`
      : expect === "runner"
        ? `judged as the runner of ${contract} (get_constants().runner names it)`
        : `not judged: pass --expect runner or --expect relayer (${contract}'s runner is ${constants.runner})`;
  const named =
    expect === null
      ? ""
      : values.key
        ? `; signing key ${values.key} (--key)`
        : "; no signing key named (--key)";
  console.log(`key scope of ${account} on testnet (${rpcUrl}), ${role}${named}`);
  const mark = (k: JudgedKey): string => {
    if (expect === null) return "·";
    if (scope.signing_key === null) return k.passes ? "✔" : "·";
    return k.signing ? (k.fit === "as declared" ? "✔" : "✖") : "·";
  };
  for (const k of scope.keys) console.log(`${mark(k)} ${k.public_key}: ${k.note}`);
  if (scope.keys.length === 0) console.log("  (no access keys)");
  console.log(`balance: ${formatNear(balance)}`);
  for (const n of scope.notes) console.log(`note: ${n}`);

  if (scope.verdict === "as declared") console.log("verdict: AS DECLARED");
  else if (scope.verdict === "not as declared" || scope.verdict === "unusable")
    console.log(`verdict: ${scope.verdict.toUpperCase()}`);
  else if (expect === null) console.log("verdict: none (keys listed only)");
  else if (scope.passing.length > 0)
    console.log(
      `verdict: no verdict on which key the ${expect} uses (pass --key <public key>); ${scope.passing.length} key(s) would pass as its signing key: ${scope.passing.join(", ")}`,
    );
  else console.log(`verdict: NO KEY WOULD PASS as the ${expect}'s signing key`);
  for (const r of scope.reasons) console.log(`  - ${r}`);
  process.exitCode =
    scope.signing_key !== null
      ? scope.verdict === "as declared"
        ? 0
        : 1
      : expect !== null && scope.passing.length === 0
        ? 1
        : 0;
}

try {
  await main();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
