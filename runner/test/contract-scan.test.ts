import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { baseEncode } from "near-api-js";
import {
  type CanChange,
  deploymentTargets,
  NO_CODE_HASH,
  parseRecordedHashes,
  type RecordedHashes,
  readRecordedHashes,
  renderScan,
  scanContracts,
  type Target,
  verdictOf,
} from "../src/contract-scan.ts";
import type { RpcExchange } from "../src/near-rpc.ts";
import { fakeRpc, readData, replayFetch } from "./support/replay-fetch.ts";

// Real NEAR RPC replies of `npm run contract-scan -- --save` on 2026-11-13 at 15:11 UTC from
// https://test.rpc.fastnear.com (test/data/contract-scan-2026-11-13T151137Z/rpc.json.gz, each exchange with its own
// fetched_at): the protocol config, view_account and view_access_key_list for the seven accounts of deployments.json,
// and the lender's whole code. Replayed offline.
const SAVED = readData<{ checked_at: string; exchanges: RpcExchange[] }>(
  "contract-scan-2026-11-13T151137Z/rpc.json.gz",
);
const RPC = "https://test.rpc.fastnear.com";
const LENDER: Target = { account_id: "lender.desk-lab-2026.testnet", label: "lender" };
const RUNNER: Target = { account_id: "intern-runner-ed25519.testnet", label: "runner" };
const NOW = () => new Date(SAVED.checked_at);

// The table of docs/REPRODUCIBLE-BUILD.md as it stood on 2026-11-13 (copied, so the test does not move with the file).
const DOC = `# Building the contracts yourself

## The expected hashes (2026-11-13, interface 1.5)

| Account | Wasm | Size (bytes) | sha256, base58 (= the account's \`code_hash\`) |
|---|---|---|---|
| \`coin.desk-lab-2026.testnet\` | \`target/near/coin/coin.wasm\` | 632,157 | \`9oufg5viW3x5eQ49p8zBkZMNvdLzyQFT7Pd4GRjuBoZK\` |
| \`usdc.desk-lab-2026.testnet\` | \`target/near/mock_usdc/mock_usdc.wasm\` | 149,106 | \`C1HZ8APmPbLQSQ9YbWNxQ563bt5XNNreneNR56qg3n8H\` |
| \`lender.desk-lab-2026.testnet\` | \`target/near/lender/lender.wasm\` | 131,977 | \`2uAJpQ3nxMsXYA5MHtVHTBMxa1WYjFaB2QAnK9uAu9Em\` |
| \`coin-fast.desk-lab-2026.testnet\` (test copy) | \`target/near/coin-fake/coin.wasm\` | 629,392 | \`DdPGocHujJSw9F5nXuXZCCbhe4gkM6wHCN89Y9Bb5WYN\` |

\`./verify.sh --quick\` on 2026-11-13 printed \`SAME\` for all seven.

## What has been checked, and what has not

| \`stub.hackcheck-2026-1103.testnet\` | x | 1 | \`4vtJ6cRc5t6aXE1GzgajcmGPyg5TYktgKAqZrZCwNPtV\` |
`;
const RECORDED: RecordedHashes = { file: "docs/REPRODUCIBLE-BUILD.md", ...parseRecordedHashes(DOC) };

const scan = (targets: Target[], over: { recorded?: RecordedHashes | null; skip?: boolean } = {}) =>
  scanContracts({ urls: [RPC], fetchFn: replayFetch(SAVED.exchanges) }, targets, {
    recorded: over.recorded === undefined ? RECORDED : over.recorded,
    skipNonContracts: over.skip ?? false,
    now: NOW,
  });

describe("the hashes the repository records", () => {
  it("reads the expected-hashes table, and only it", () => {
    assert.equal(RECORDED.heading, "The expected hashes (2026-11-13, interface 1.5)");
    assert.deepEqual(
      RECORDED.rows.map((r) => [r.account_id, r.size]),
      [
        ["coin.desk-lab-2026.testnet", 632157],
        ["usdc.desk-lab-2026.testnet", 149106],
        ["lender.desk-lab-2026.testnet", 131977],
        ["coin-fast.desk-lab-2026.testnet", 629392],
      ],
    );
    assert.deepEqual(
      parseRecordedHashes("# nothing here\n| `a.testnet` | `11111111111111111111111111111111` |"),
      {
        heading: null,
        rows: [],
      },
    );
  });

  it("finds the table in the owner's docs/REPRODUCIBLE-BUILD.md", () => {
    const real = readRecordedHashes();
    assert.ok(real, "docs/REPRODUCIBLE-BUILD.md is in the repository");
    assert.ok(real.rows.length >= 1);
    assert.ok(real.rows.every((r) => /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(r.hash)));
  });
});

describe("the default list", () => {
  it("takes the account ids under testnet in deployments.json, not the URLs", () => {
    const targets = deploymentTargets({
      testnet: {
        stub: "stub.hackcheck-2026-1103.testnet",
        coin: "coin.desk-lab-2026.testnet",
        runner: "intern-runner-ed25519.testnet",
        rpc: "https://test.rpc.fastnear.com",
        trick_api: "https://intern-runner-production.up.railway.app",
        n: 3,
      },
    });
    assert.deepEqual(
      targets.map((t) => t.label),
      ["stub", "coin", "runner"],
    );
    assert.deepEqual(deploymentTargets(null), []);
  });
});

describe("contract-scan on the recorded replies", () => {
  it("judges the lender: its recorded build, one full-access key, and all 11 control host functions imported", async () => {
    const rep = await scan([LENDER]);
    assert.equal(rep.network, "testnet");
    assert.equal(rep.storage_price_per_byte_yocto, "10000000000000000000");
    const a = rep.accounts[0];
    assert.ok(a);
    assert.equal(a.code.hash, "2uAJpQ3nxMsXYA5MHtVHTBMxa1WYjFaB2QAnK9uAu9Em");
    assert.equal(a.code.bytes, 131977);
    assert.equal(a.code.matches_code_hash, true);
    assert.equal(a.recorded.same, true);
    assert.equal(a.keys.full_access, 1);
    assert.equal(a.keys.list[0]?.public_key, "ed25519:9TFnGFYUtqKNG1nVbL5UTMeEHe2bD1PxHZwkjnLfySap");
    assert.equal(a.imports?.host_functions.length, 35);
    assert.equal(a.can_change.code.length, 11);
    assert.equal(a.can_change.nobody, false);
    assert.equal(a.status, "warn");
    assert.deepEqual(a.problems, []);
    assert.match(a.verdict, /^1 full-access key: the holder can change it/);
    assert.match(a.verdict, /imports all 11 host functions .* cannot rule out a code path/);
    // 132,486 bytes at 10^19 yocto each, out of a 1.998869 NEAR balance.
    assert.equal(a.storage_usage, 132486);
    assert.equal(a.storage?.cost_yocto, "1324860000000000000000000");
    assert.equal(
      a.storage?.room_bytes,
      Number((BigInt(a.balance_yocto) - 1324860000000000000000000n) / 10n ** 19n),
    );
    assert.equal(rep.summary.ok, true);
  });

  it("scans an account without code when named, and skips it in the default list", async () => {
    const named = await scan([RUNNER]);
    const r = named.accounts[0];
    assert.ok(r);
    assert.equal(r.code.deployed, false);
    assert.equal(r.code.hash, NO_CODE_HASH);
    assert.equal(r.imports, null);
    assert.deepEqual(
      r.keys.list.map((k) => k.kind),
      ["full-access", "function-call"],
    );
    assert.match(r.verdict, /^1 full-access key: the holder can change it/);
    assert.doesNotMatch(r.verdict, /imports/);
    const skipped = await scan([RUNNER, LENDER], { skip: true });
    assert.deepEqual(skipped.skipped, [
      { account_id: RUNNER.account_id, label: "runner", reason: "no contract code deployed" },
    ]);
    assert.equal(skipped.summary.contracts, 1);
  });

  it("fails an account whose code differs from the recorded build, and warns when none is recorded", async () => {
    const other: RecordedHashes = {
      ...RECORDED,
      rows: RECORDED.rows.map((r) =>
        r.account_id === LENDER.account_id
          ? { ...r, hash: "4vtJ6cRc5t6aXE1GzgajcmGPyg5TYktgKAqZrZCwNPtV" }
          : r,
      ),
    };
    const bad = (await scan([LENDER], { recorded: other })).accounts[0];
    assert.equal(bad?.status, "fail");
    assert.equal(bad?.recorded.same, false);
    assert.match(bad?.problems[0] ?? "", /records 4vtJ6c.*but the code on chain is 2uAJpQ/);
    const none = (await scan([LENDER], { recorded: { ...RECORDED, rows: [] } })).accounts[0];
    assert.equal(none?.recorded.same, null);
    assert.match(none?.caveats[0] ?? "", /not tied to the source: the repository records no hash/);
    const absent = (await scan([LENDER], { recorded: null })).accounts[0];
    assert.match(absent?.recorded.note ?? "", /not here/);
  });

  it("lists an account it cannot read as failed and goes on", async () => {
    const rep = await scan([{ account_id: "nobody-here.testnet", label: null }, LENDER]);
    assert.equal(rep.failed.length, 1);
    assert.match(rep.failed[0]?.error ?? "", /not recorded/);
    assert.equal(rep.accounts.length, 1);
    assert.equal(rep.summary.ok, false);
  });

  it("prints one block per account and a summary", async () => {
    const lines = renderScan(await scan([LENDER, RUNNER], { skip: true }));
    const text = lines.join("\n");
    assert.match(text, /lender\.desk-lab-2026\.testnet \(lender\)\n {2}code {7}2uAJ/);
    assert.match(text, /recorded {3}SAME: /);
    assert.match(
      text,
      /imports {4}35 NEAR host functions; 11 of the 11 that can change control: deploy_contract/,
    );
    assert.match(text, /intern-runner-ed25519\.testnet \(runner\): skipped, no contract code deployed/);
    assert.match(
      lines[lines.length - 1] ?? "",
      /^SUMMARY {2}1 account\(s\) scanned, 1 with a contract: 0 nobody can change, 1 changeable/,
    );
  });
});

/** A hand-made module importing `names` from env, and a fake RPC serving it for one account with `keys`. */
function synthetic(names: string[], keys: unknown[], extra: Record<string, unknown> = {}) {
  const leb = (n: number) => (n < 128 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
  const str = (s: string) => [...leb(s.length), ...Buffer.from(s)];
  const entries = names.flatMap((n) => [...str("env"), ...str(n), 0, 0]);
  const body = [...leb(names.length), ...entries];
  const code = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2, ...leb(body.length), ...body]);
  const hash = baseEncode(createHash("sha256").update(code).digest());
  const fetchFn = fakeRpc((method, p) => {
    if (method === "EXPERIMENTAL_protocol_config")
      return { chain_id: "testnet", runtime_config: { storage_amount_per_byte: "10000000000000000000" } };
    if (p.request_type === "view_account")
      return {
        amount: "2000000000000000000000000",
        locked: "0",
        code_hash: hash,
        storage_usage: 1000,
        ...extra,
      };
    if (p.request_type === "view_access_key_list") return { keys };
    if (p.request_type === "view_code") return { code_base64: code.toString("base64"), hash };
    return new Error("unexpected");
  });
  return { fetchFn, hash };
}

describe("contract-scan verdicts on hand-made accounts", () => {
  const run = async (s: ReturnType<typeof synthetic>) =>
    (
      await scanContracts({ urls: [RPC], fetchFn: s.fetchFn }, [{ account_id: "x.testnet", label: null }], {
        recorded: null,
        skipNonContracts: false,
        now: NOW,
      })
    ).accounts[0];

  it("says nobody can change a keyless contract whose code imports no control host function", async () => {
    const a = await run(synthetic(["input", "value_return", "promise_batch_action_function_call"], []));
    assert.equal(a?.can_change.nobody, true);
    assert.equal(
      a?.verdict,
      "0 full-access keys and no code path that deploys code, changes keys or deletes the account: nobody can change it",
    );
    assert.equal(a?.code.matches_code_hash, true);
    assert.deepEqual(a?.imports?.other_actions, ["promise_batch_action_function_call"]);
  });

  it("says a keyless contract that imports deploy_contract cannot be ruled out", async () => {
    const a = await run(synthetic(["promise_batch_action_deploy_contract"], []));
    assert.equal(a?.status, "warn");
    assert.match(a?.verdict ?? "", /^0 full-access keys, but its code imports 1 of the 11 host functions/);
  });

  it("names the account a global contract follows, and function-call keys for the contract itself", async () => {
    const own = {
      public_key: "ed25519:k",
      access_key: {
        permission: { FunctionCall: { receiver_id: "x.testnet", method_names: [], allowance: null } },
      },
    };
    // As near-primitives' AccountView gives it: no local code hash, and the account the code follows.
    const s = synthetic(["input"], [own], {
      code_hash: NO_CODE_HASH,
      global_contract_account_id: "publisher.testnet",
    });
    const a = await run(s);
    assert.equal(a?.code.deployed, true);
    assert.equal(
      a?.code.matches_code_hash,
      null,
      "nothing to compare with: it follows an account, not a hash",
    );
    assert.equal(a?.can_change.global_owner, "publisher.testnet");
    assert.match(a?.verdict ?? "", /global contract published by publisher\.testnet/);
    assert.match(a?.verdict ?? "", /1 function-call key for its own contract/);
  });

  it("fails when the code read does not hash to the account's code hash", async () => {
    const s = synthetic(["input"], [], { code_hash: "4vtJ6cRc5t6aXE1GzgajcmGPyg5TYktgKAqZrZCwNPtV" });
    const a = await run(s);
    assert.equal(a?.status, "fail");
    assert.equal(a?.code.matches_code_hash, false);
  });

  it("reads no account when the RPC serves another network", async () => {
    const fetchFn = fakeRpc((method) =>
      method === "EXPERIMENTAL_protocol_config"
        ? { chain_id: "mainnet", runtime_config: {} }
        : new Error("no"),
    );
    await assert.rejects(
      scanContracts({ urls: [RPC], fetchFn }, [LENDER], {
        recorded: null,
        skipNonContracts: false,
        now: NOW,
        network: "testnet",
      }),
      /is mainnet, not testnet/,
    );
    assert.deepEqual(fetchFn.calls, ["EXPERIMENTAL_protocol_config  "]);
  });

  it("covers every way an account can be changed in its verdict", () => {
    const none: CanChange = {
      full_access_keys: 0,
      unknown_keys: 0,
      own_function_call_keys: 0,
      code: [],
      code_unread: false,
      global_owner: null,
      nobody: true,
    };
    assert.match(verdictOf(none, false), /^no code and 0 full-access keys: nobody can deploy code/);
    assert.equal(
      verdictOf({ ...none, full_access_keys: 2, nobody: false }, true),
      "2 full-access keys: the holder can change it (deploy new code, add or delete keys, delete the account); its code has no path that can (it imports none of the host functions that do)",
    );
    assert.match(
      verdictOf({ ...none, unknown_keys: 1, nobody: false }, true),
      /1 key with a permission this scan does not know/,
    );
    assert.match(verdictOf({ ...none, code_unread: true, nobody: false }, true), /could not be read/);
  });
});
